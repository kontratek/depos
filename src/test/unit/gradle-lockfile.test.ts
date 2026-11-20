import { describe, expect, it } from 'vitest';
import { gradleLockfileFor, isGradleLockfilePath, parseGradleLockfile } from '../../core/gradle-lockfile';

const lockfile = [
  '# This is a Gradle generated file for dependency locking.',
  '# Manual edits can break the build and are not advised.',
  '# This file is expected to be part of source control.',
  'com.google.guava:failureaccess:1.0.2=compileClasspath,runtimeClasspath',
  'com.google.guava:guava:33.4.0-jre=compileClasspath,runtimeClasspath,testCompileClasspath',
  'org.slf4j:slf4j-api:2.0.13=compileClasspath,runtimeClasspath',
  'org.slf4j:slf4j-api:2.0.16=testCompileClasspath,testRuntimeClasspath',
  'empty=annotationProcessor,testAnnotationProcessor',
  '',
].join('\r\n');

describe('Gradle lock files', () => {
  it('owns gradle.lockfile only, not the buildscript\'s', () => {
    expect(isGradleLockfilePath('app/gradle.lockfile')).toBe(true);
    expect(isGradleLockfilePath('app/buildscript-gradle.lockfile')).toBe(false);
  });

  it('finds the lock file beside the build file only', () => {
    const paths = new Set(['gradle.lockfile', 'app/gradle.lockfile']);
    expect(gradleLockfileFor('app/build.gradle.kts', paths)).toBe('app/gradle.lockfile');
    expect(gradleLockfileFor('build.gradle', paths)).toBe('gradle.lockfile');
    expect(gradleLockfileFor('lib/build.gradle', paths)).toBeUndefined();
  });

  it('resolves a module by its group and artifact, as written', () => {
    const parsed = parseGradleLockfile('gradle.lockfile', lockfile);
    expect(parsed.resolve('build.gradle', 'com.google.guava:guava', '33.0.0-jre')).toBe('33.4.0-jre');
    expect(parsed.resolve('build.gradle', 'COM.GOOGLE.GUAVA:guava', undefined)).toBeUndefined();
    expect(parsed.resolve('build.gradle', 'com.google.guava:missing', undefined)).toBeUndefined();
  });

  it('gives no version when configurations resolve different ones', () => {
    expect(parseGradleLockfile('gradle.lockfile', lockfile).resolve('build.gradle', 'org.slf4j:slf4j-api', undefined)).toBeUndefined();
  });

  it('reads a lock file with nothing locked, and throws on one that is not a lock file', () => {
    expect(parseGradleLockfile('gradle.lockfile', 'empty=compileClasspath\n').resolve('build.gradle', 'a:b', undefined)).toBeUndefined();
    expect(() => parseGradleLockfile('gradle.lockfile', '{"version":2}')).toThrow();
  });
});
