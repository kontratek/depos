package dev.pacmon.jetbrains.service

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Computable

/**
 * A blocking read action, for the callers that need a value now: the line painter,
 * the index lookups, the project roots.
 *
 * ReadAction.compute is deprecated from 2026.2 (262), and its replacement,
 * ReadAction.computeBlocking, does not exist before 262. The plugin still supports
 * 2025.2 (sinceBuild 252), so neither can be used on every IDE it installs into.
 * Application.runReadAction is what ReadAction.compute calls, and it is not
 * deprecated in either. When sinceBuild reaches 262, this becomes computeBlocking.
 */
inline fun <T> blockingRead(crossinline compute: () -> T): T =
    ApplicationManager.getApplication().runReadAction(Computable { compute() })
