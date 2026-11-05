plugins {
    kotlin("jvm")
}

dependencies {
    // The controller exposes suspend APIs and needs a real single-flight guard.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5:2.0.21")
    testImplementation("com.google.code.gson:gson:2.11.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
}

kotlin { jvmToolchain(21) }

tasks.test {
    useJUnitPlatform()
    testLogging { events("passed", "failed", "skipped") }
}
