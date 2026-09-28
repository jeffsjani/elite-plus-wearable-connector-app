# JCVital plugin boundary

No native Capacitor Kotlin plugin is implemented here yet. Build 7A defined
the TypeScript-side bridge contract (`src/adapters/jcvital/jcvitalBridge.ts`)
that a future native implementation must satisfy, but no actual vendor
Android SDK (AAR/JAR/Kotlin/Java source) was available to inspect or wrap —
see [`src/adapters/jcvital/README.md`](../../src/adapters/jcvital/README.md)
for the full evidence trail and blockers.
