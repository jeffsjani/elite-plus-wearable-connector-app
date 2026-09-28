export const rookProviders = [
  { dataSource: 'GARMIN', name: 'Garmin' },
  { dataSource: 'OURA', name: 'Oura' },
  { dataSource: 'POLAR', name: 'Polar' },
  { dataSource: 'FITBIT', name: 'Fitbit' },
  { dataSource: 'WITHINGS', name: 'Withings' },
  { dataSource: 'WHOOP', name: 'WHOOP' },
  { dataSource: 'DEXCOM', name: 'Dexcom' },
] as const

export type RookDataSource = (typeof rookProviders)[number]['dataSource']

export function isRookDataSource(value: string): value is RookDataSource {
  return rookProviders.some((provider) => provider.dataSource === value)
}