import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing — loaded from android/key.properties when present.
// If the file is missing (CI without secrets, fresh clone for debug-only
// work), release builds fall back to the debug keys so `flutter run
// --release` still works locally without forcing every contributor to
// configure signing.
val keystoreProperties = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) {
        load(FileInputStream(f))
    }
}
val hasReleaseKeystore = keystoreProperties.getProperty("storeFile") != null

android {
    namespace = "work.jacobmoura.remoteomp"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "work.jacobmoura.remoteomp"
        // plan/23 § "Minimum Android version" — remote_pi_identity plugin requires API 34.
        minSdk = 34
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // `--target-platform android-arm64` only drops Flutter's own .so files;
        // plugin prebuilts (ML Kit, sqlite, CameraX) still ship for every ABI.
        // Filter them too so a phone build is ~33 MB instead of ~88 MB. Skipped
        // under --split-per-abi, which configures ABI splits itself.
        val targetPlatforms = project.findProperty("target-platform") as String?
        if (targetPlatforms != null && project.findProperty("split-per-abi") != "true") {
            val abiByPlatform = mapOf(
                "android-arm" to "armeabi-v7a",
                "android-arm64" to "arm64-v8a",
                "android-x64" to "x86_64",
            )
            ndk {
                // The Flutter plugin pre-fills all three ABIs; replace, don't append.
                abiFilters.clear()
                abiFilters += targetPlatforms.split(",").mapNotNull { abiByPlatform[it.trim()] }
            }
        }
    }

    // Compress native libs inside the APK (they are stored uncompressed by
    // default). The APK is sideloaded, so download/transfer size matters more
    // than the extra install-time extraction: arm64 drops from ~33 MB to ~17 MB.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                // PKCS12 file with a legacy .jks name — AGP would infer JKS
                // from the extension and fail with "Tag number over 30".
                storeType = keystoreProperties.getProperty("storeType") ?: "PKCS12"
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    // 16 KB page-size compliance (Google Play, enforced since Nov 2025).
    // mobile_scanner 5.2.3 pulls ML Kit + CameraX whose prebuilt native libs
    // are only 4 KB-aligned (libbarhopper_v3.so, libimage_processing_util_jni.so),
    // which Play now rejects. Force the newer, 16 KB-aligned releases — Gradle
    // version-conflict resolution picks these over mobile_scanner's transitive
    // 17.2.0 / 1.3.3. No Dart-side scanner API change. CameraX modules are kept
    // on one matching version to avoid cross-module runtime mismatches.
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    // Plan 65 — FileProvider for the received-files APK install intent
    // (same version share_plus already pulls in).
    implementation("androidx.core:core-ktx:1.16.0")
}
