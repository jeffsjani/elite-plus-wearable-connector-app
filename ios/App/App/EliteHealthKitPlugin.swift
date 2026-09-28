import Capacitor
import Foundation
import HealthKit

@objc(EliteHealthKitPlugin)
public class EliteHealthKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EliteHealthKitPlugin"
    public let jsName = "EliteHealthKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSamples", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryWorkouts", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()

    @objc public func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    private func sampleType(_ name: String) -> HKSampleType? {
        switch name {
        case "heartRate": return HKObjectType.quantityType(forIdentifier: .heartRate)
        case "restingHeartRate": return HKObjectType.quantityType(forIdentifier: .restingHeartRate)
        case "heartRateVariability": return HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)
        case "sleep": return HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        case "steps": return HKObjectType.quantityType(forIdentifier: .stepCount)
        case "calories": return HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)
        case "respiratoryRate": return HKObjectType.quantityType(forIdentifier: .respiratoryRate)
        case "oxygenSaturation": return HKObjectType.quantityType(forIdentifier: .oxygenSaturation)
        case "weight": return HKObjectType.quantityType(forIdentifier: .bodyMass)
        case "height": return HKObjectType.quantityType(forIdentifier: .height)
        case "workouts": return HKObjectType.workoutType()
        default: return nil
        }
    }

    @objc public func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("HealthKit unavailable"); return }
        let requested = call.getArray("read", String.self) ?? []
        guard !requested.isEmpty, requested.allSatisfy({ sampleType($0) != nil }) else {
            call.reject("Unsupported HealthKit read type")
            return
        }
        let types: Set<HKObjectType> = Set(requested.compactMap { sampleType($0) as HKObjectType? })
        store.requestAuthorization(toShare: Set<HKSampleType>(), read: types) { success, error in
            if let error = error { call.reject("HealthKit authorization failed", nil, error); return }
            if !success { call.reject("HealthKit authorization failed"); return }
            call.resolve(["readAuthorized": requested, "readDenied": []])
        }
    }

    private func date(_ text: String?) -> Date? {
        guard let text = text else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: text) { return parsed }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    private func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func query(_ call: CAPPluginCall, type: HKSampleType, resultKey: String, transform: @escaping (HKSample) -> [String: Any]?) {
        guard let start = date(call.getString("startDate")),
              let end = date(call.getString("endDate")), start < end else {
            call.reject("Invalid HealthKit query range")
            return
        }
        let limit = min(max(call.getInt("limit") ?? 5000, 1), 5000)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        let request = HKSampleQuery(sampleType: type, predicate: predicate, limit: limit, sortDescriptors: [sort]) { _, samples, error in
            if let error = error { call.reject("HealthKit read failed", nil, error); return }
            call.resolve([resultKey: (samples ?? []).compactMap(transform)])
        }
        store.execute(request)
    }

    private func unit(_ name: String) -> (HKUnit, String)? {
        switch name {
        case "heartRate", "restingHeartRate", "respiratoryRate":
            return (HKUnit.count().unitDivided(by: HKUnit.minute()), name == "respiratoryRate" ? "breaths/minute" : "bpm")
        case "heartRateVariability": return (HKUnit.secondUnit(with: .milli), "millisecond")
        case "steps": return (HKUnit.count(), "count")
        case "calories": return (HKUnit.kilocalorie(), "kilocalorie")
        case "oxygenSaturation": return (HKUnit.percent(), "percent")
        case "weight": return (HKUnit.gramUnit(with: .kilo), "kilogram")
        case "height": return (HKUnit.meterUnit(with: .centi), "centimeter")
        default: return nil
        }
    }

    private func sleepState(_ value: Int) -> String? {
        if value == HKCategoryValueSleepAnalysis.inBed.rawValue { return "inBed" }
        if value == 1 { return "asleep" }
        if #available(iOS 16.0, *) {
            if value == HKCategoryValueSleepAnalysis.awake.rawValue { return "awake" }
            if value == HKCategoryValueSleepAnalysis.asleepCore.rawValue { return "light" }
            if value == HKCategoryValueSleepAnalysis.asleepDeep.rawValue { return "deep" }
            if value == HKCategoryValueSleepAnalysis.asleepREM.rawValue { return "rem" }
        }
        return nil
    }

    @objc public func readSamples(_ call: CAPPluginCall) {
        guard let name = call.getString("dataType"), name != "workouts", let type = sampleType(name) else {
            call.reject("Unsupported HealthKit sample type")
            return
        }
        query(call, type: type, resultKey: "samples") { sample in
            var value: Double
            var unitName: String
            var extra: [String: Any] = [:]
            if let category = sample as? HKCategorySample, name == "sleep" {
                guard let state = self.sleepState(category.value) else { return nil }
                value = category.endDate.timeIntervalSince(category.startDate) / 60
                unitName = "minute"
                extra["sleepState"] = state
            } else if let quantity = sample as? HKQuantitySample, let unit = self.unit(name) {
                value = quantity.quantity.doubleValue(for: unit.0)
                unitName = unit.1
            } else { return nil }
            guard value.isFinite else { return nil }
            extra.merge([
                "value": value, "unit": unitName,
                "startDate": self.iso(sample.startDate), "endDate": self.iso(sample.endDate),
                "platformId": sample.uuid.uuidString,
                "sourceName": sample.sourceRevision.source.name,
                "sourceId": sample.sourceRevision.source.bundleIdentifier
            ]) { _, new in new }
            return extra
        }
    }

    @objc public func queryWorkouts(_ call: CAPPluginCall) {
        query(call, type: HKObjectType.workoutType(), resultKey: "workouts") { sample in
            guard let workout = sample as? HKWorkout else { return nil }
            return [
                "duration": workout.duration,
                "workoutType": String(workout.workoutActivityType.rawValue),
                "startDate": self.iso(workout.startDate), "endDate": self.iso(workout.endDate),
                "platformId": workout.uuid.uuidString,
                "sourceName": workout.sourceRevision.source.name,
                "sourceId": workout.sourceRevision.source.bundleIdentifier
            ]
        }
    }
}