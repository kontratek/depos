import { describe, expect, it } from 'vitest';
import { isMixLockfilePath, mixLockfileFor, parseMixLockfile } from '../../core/mix-lockfile';

const lock = [
  '%{',
  '  "phoenix": {:hex, :phoenix, "1.7.10", "02189140a61b2ce85bb633a9b6fd02dff705a5f1596869547aeb2b2b95edd729", [:mix], [{:castore, ">= 0.0.0", [hex: :castore, repo: "hexpm", optional: false]}], "hexpm", "cf784932e010fd736d656d7fead6a584a4498efefe5b8227e9f383bf15bb79d0"},',
  '  "jason": {:hex, :jason, "1.4.4", "b9226785a9aa77b6857ca22832cffa5d5011a667207eb2a0ad56adb5db443b8a", [:mix], [], "hexpm", "c5eb0cab91f094599f94d55bc63409236a8ec69a21a67814529e8d5f6cc90b3b"},',
  '  "plug": {:git, "https://example.test/plug.git", "0123abc", [tag: "v1"]},',
  '  "renamed": {:hex, :real_name, "2.0.1", "aa", [:mix], [], "hexpm", "bb"},',
  '  "private": {:hex, :private, "1.0.0", "aa", [:mix], [], "hexpm:acme", "bb"},',
  '  "quoted": {:hex, :"quoted", "0.3.0", "aa", [:mix], [], "hexpm", "bb"},',
  '}',
].join('\n');

describe('isMixLockfilePath and mixLockfileFor', () => {
  it('takes the umbrella root\'s lockfile for an app', () => {
    expect(isMixLockfilePath('apps/web/mix.lock')).toBe(true);
    expect(isMixLockfilePath('mix.exs')).toBe(false);
    expect(mixLockfileFor('apps/web/mix.exs', new Set(['mix.lock']))).toBe('mix.lock');
  });
});

describe('mix.lock', () => {
  const parsed = parseMixLockfile('mix.lock', lock);

  it('gives a hex.pm package its locked version', () => {
    expect(parsed.resolve('mix.exs', 'phoenix', '~> 1.7')).toBe('1.7.10');
    expect(parsed.resolve('mix.exs', 'jason', undefined)).toBe('1.4.4');
    expect(parsed.resolve('mix.exs', 'quoted', '~> 0.3')).toBe('0.3.0');
  });

  it('gives none for a git, renamed or private package, or what it does not hold', () => {
    expect(parsed.resolve('mix.exs', 'plug', 'git+https://example.test/plug.git')).toBeUndefined();
    expect(parsed.resolve('mix.exs', 'renamed', 'package:real_name')).toBeUndefined();
    // Even when the manifest's spec does not say so, the lockfile does.
    expect(parsed.resolve('mix.exs', 'renamed', '~> 2.0')).toBeUndefined();
    expect(parsed.resolve('mix.exs', 'private', '~> 1.0')).toBeUndefined();
    expect(parsed.resolve('mix.exs', 'missing', '~> 1.0')).toBeUndefined();
  });

  it('refuses a text that is not a Mix lockfile', () => {
    expect(() => parseMixLockfile('mix.lock', '[[package]]\nname = "x"')).toThrow();
  });
});
