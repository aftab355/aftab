# Weight Sync (Android)

Reads weigh-ins from Health Connect and sends them to the calorie tracker's
`/api/sync`. What it does and why is in the main README under *Automatic
weight from the phone*. This file covers building it.

## Layout

- `SyncCore.kt`: key derivation and the merge rules. Plain Kotlin, unit tested
  (`app/src/test`), including a check that the key matches the website's
  for ASCII and non-ASCII passphrases.
- `SyncEngine.kt`: Health Connect reads and HTTP.
- `SyncWorker.kt`: the 3-hourly background job.
- `MainActivity.kt`: the one screen. `PrivacyActivity.kt` is the rationale
  page Health Connect requires before it will show its permission dialog.

## Build

Needs JDK 17+ and the Android SDK (platform 36). Point `local.properties` at
the SDK (`sdk.dir=/path/to/android-sdk`), then:

```bash
./gradlew testDebugUnitTest      # unit tests
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease        # minified; signed only if keystore.properties exists
cp app/build/outputs/apk/release/app-release.apk calorie-weight-sync.apk
```

## Signing

The repo is public, so the release key is **not** committed: anyone holding it
could build an "update" that installs over the real app. Release signing
reads `android/keystore.properties` (gitignored):

```
storeFile=/absolute/path/to/weightsync-release.jks
storePassword=...
keyAlias=weightsync
keyPassword=...
```

Android only installs an update signed with the same key as the installed
copy. If the key is lost, uninstall the app and install the new build. You
then reconnect and re-grant Health Connect, which takes a minute, and nothing
on the website is affected.

The APK checked in at `calorie-weight-sync.apk` is signed with a key whose
certificate SHA-256 is
`87:d8:86:aa:d7:d1:af:e8:72:7e:d2:b9:f9:02:34:11:b5:8a:29:06:50:7d:1d:1a:1a:6e:7a:fc:ea:65:a2:ce`.
