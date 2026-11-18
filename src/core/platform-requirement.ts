import type { ManifestKind } from './model';

/**
 * Composer's platform requirements: the PHP version, PHP extensions, system
 * libraries and Composer's own APIs. A manifest declares them as dependencies and
 * a notes file can document them (`## php`, `## ext-mbstring`), but no registry
 * publishes them and nothing installs them, so an allowlist has nothing to decide.
 */
const COMPOSER_PLATFORM = /^(?:php(?:-[A-Za-z0-9_.-]+)?|hhvm|ext-[A-Za-z0-9_.-]+|lib-[A-Za-z0-9_.-]+|composer(?:-(?:plugin|runtime)-api)?)$/i;

/** Whether a dependency is a requirement on the platform rather than a package. */
export function isPlatformRequirement(kind: ManifestKind | string, name: string): boolean {
  return kind === 'composer' && COMPOSER_PLATFORM.test(name);
}
