import { describe, expect, it } from 'vitest';
import { isPythonLockfilePath, parsePythonLockfile, pythonLockfileFor } from '../../core/python-lockfile';

describe('isPythonLockfilePath', () => {
  it('knows the lockfiles at any depth', () => {
    expect(isPythonLockfilePath('uv.lock')).toBe(true);
    expect(isPythonLockfilePath('services/api/poetry.lock')).toBe(true);
    expect(isPythonLockfilePath('pyproject.toml')).toBe(false);
    expect(isPythonLockfilePath('my-uv.lock')).toBe(false);
  });
});

describe('pythonLockfileFor', () => {
  it('takes the closest lockfile at or above the manifest', () => {
    const paths = new Set(['uv.lock', 'services/legacy/poetry.lock']);
    expect(pythonLockfileFor('pyproject.toml', paths)).toBe('uv.lock');
    expect(pythonLockfileFor('services/api/pyproject.toml', paths)).toBe('uv.lock');
    expect(pythonLockfileFor('services/legacy/pyproject.toml', paths)).toBe('services/legacy/poetry.lock');
    expect(pythonLockfileFor('services/legacy/sub/requirements.txt', paths)).toBe('services/legacy/poetry.lock');
  });

  it('does not take a lockfile from a sibling directory or a similar name', () => {
    expect(pythonLockfileFor('services/api/pyproject.toml', new Set(['services/web/uv.lock']))).toBeUndefined();
    expect(pythonLockfileFor('pyproject.toml', new Set(['old-uv.lock']))).toBeUndefined();
  });

  it('prefers uv over Poetry in one directory', () => {
    expect(pythonLockfileFor('pyproject.toml', new Set(['poetry.lock', 'uv.lock']))).toBe('uv.lock');
  });
});

describe('uv.lock', () => {
  const text = [
    'version = 1',
    'requires-python = ">=3.12"',
    '',
    '[[package]]',
    'name = "requests"',
    'version = "2.32.3"',
    'source = { registry = "https://pypi.org/simple" }',
    'dependencies = [',
    '    { name = "idna" },',
    '    { name = "urllib3" },',
    ']',
    'sdist = { url = "https://example.invalid/requests-2.32.3.tar.gz", hash = "sha256:aa", size = 131218 }',
    'wheels = [',
    '    { url = "https://example.invalid/requests-2.32.3-py3-none-any.whl", hash = "sha256:bb", size = 64928 },',
    ']',
    '',
    '[[package]]',
    'name = "Flask-SQLAlchemy"',
    'version = "3.1.1"',
    'source = { registry = "https://pypi.org/simple" }',
    '',
    '[[package]]',
    'name = "my-app"',
    'version = "0.1.0"',
    'source = { editable = "." }',
    '',
    '[package.metadata]',
    'requires-dist = [{ name = "requests", specifier = ">=2" }]',
    '',
  ].join('\n');
  const lock = parsePythonLockfile('uv.lock', text);

  it('gives the installed version of a package from the index', () => {
    expect(lock.resolve('pyproject.toml', 'requests', undefined)).toBe('2.32.3');
  });

  it('does not read a package out of another package\'s dependencies', () => {
    expect(lock.resolve('pyproject.toml', 'idna', undefined)).toBeUndefined();
    expect(lock.resolve('pyproject.toml', 'urllib3', undefined)).toBeUndefined();
  });

  it('matches names the way PEP 503 does', () => {
    expect(lock.resolve('pyproject.toml', 'flask_sqlalchemy', undefined)).toBe('3.1.1');
    expect(lock.resolve('pyproject.toml', 'Flask.SQLAlchemy', undefined)).toBe('3.1.1');
  });

  it('leaves out a package that is a local path, not a release', () => {
    expect(lock.resolve('pyproject.toml', 'my-app', undefined)).toBeUndefined();
  });

  it('answers for a manifest anywhere under the lockfile', () => {
    expect(lock.resolve('services/api/requirements.txt', 'requests', undefined)).toBe('2.32.3');
  });

  it('gives no version for a package the file resolves more than one way', () => {
    const forked = parsePythonLockfile('uv.lock', [
      'version = 1',
      '',
      '[[package]]',
      'name = "tomli"',
      'version = "2.0.1"',
      'source = { registry = "https://pypi.org/simple" }',
      '',
      '[[package]]',
      'name = "tomli"',
      'version = "2.2.1"',
      'source = { registry = "https://pypi.org/simple" }',
      '',
    ].join('\n'));
    expect(forked.resolve('pyproject.toml', 'tomli', undefined)).toBeUndefined();
  });

  it('reads the versions PEP 440 allows, and no others', () => {
    const versions = parsePythonLockfile('uv.lock', [
      'version = 1',
      '',
      '[[package]]',
      'name = "pre"',
      'version = "2.0.0rc1"',
      '',
      '[[package]]',
      'name = "dated"',
      'version = "2024.7.4"',
      '',
      '[[package]]',
      'name = "epoched"',
      'version = "1!2.0"',
      '',
      '[[package]]',
      'name = "posted"',
      'version = "1.0.post1"',
      '',
      '[[package]]',
      'name = "odd"',
      'version = "not a version"',
      '',
    ].join('\n'));
    expect(versions.resolve('pyproject.toml', 'pre', undefined)).toBe('2.0.0rc1');
    expect(versions.resolve('pyproject.toml', 'dated', undefined)).toBe('2024.7.4');
    expect(versions.resolve('pyproject.toml', 'epoched', undefined)).toBe('1!2.0');
    expect(versions.resolve('pyproject.toml', 'posted', undefined)).toBe('1.0.post1');
    expect(versions.resolve('pyproject.toml', 'odd', undefined)).toBeUndefined();
  });

  it('is not confused by a comment or a hash that looks like one', () => {
    const commented = parsePythonLockfile('uv.lock', [
      'version = 1',
      '',
      '[[package]]  # the only one',
      'name = "idna"  # a comment',
      'version = "3.7"',
      'source = { registry = "https://example.invalid/simple#fragment" }',
      '',
    ].join('\n'));
    expect(commented.resolve('pyproject.toml', 'idna', undefined)).toBe('3.7');
  });

  it('refuses a file that is not a uv lockfile', () => {
    expect(() => parsePythonLockfile('uv.lock', '[[package]]\nname = "requests"\n')).toThrow();
    expect(() => parsePythonLockfile('uv.lock', 'nope')).toThrow();
  });
});

describe('poetry.lock', () => {
  const text = [
    '# This file is automatically @generated by Poetry and should not be changed by hand.',
    '',
    '[[package]]',
    'name = "certifi"',
    'version = "2024.7.4"',
    'description = "Python package for providing Mozilla\'s CA Bundle."',
    'optional = false',
    'python-versions = ">=3.6"',
    'files = [',
    '    {file = "certifi-2024.7.4-py3-none-any.whl", hash = "sha256:aa"},',
    '    {file = "certifi-2024.7.4.tar.gz", hash = "sha256:bb"},',
    ']',
    '',
    '[[package]]',
    'name = "internal-lib"',
    'version = "1.4.0"',
    'description = "From a checkout."',
    'optional = false',
    'python-versions = "*"',
    '',
    '[package.dependencies]',
    'certifi = ">=2024"',
    '',
    '[package.source]',
    'type = "git"',
    'url = "https://example.invalid/internal-lib.git"',
    'reference = "main"',
    '',
    '[[package]]',
    'name = "private-dep"',
    'version = "2.1.0"',
    'description = "From another index."',
    'optional = false',
    'python-versions = "*"',
    '',
    '[package.source]',
    'type = "legacy"',
    'url = "https://example.invalid/simple"',
    'reference = "internal"',
    '',
    '[metadata]',
    'lock-version = "2.0"',
    'content-hash = "abc"',
    '',
  ].join('\n');
  const lock = parsePythonLockfile('poetry.lock', text);

  it('gives the installed version of a package from PyPI', () => {
    expect(lock.resolve('pyproject.toml', 'certifi', undefined)).toBe('2024.7.4');
  });

  it('does not read a name out of a file list or a dependency table', () => {
    expect(lock.resolve('pyproject.toml', 'certifi-2024.7.4-py3-none-any.whl', undefined)).toBeUndefined();
  });

  it('leaves out a package that comes from a checkout', () => {
    expect(lock.resolve('pyproject.toml', 'internal-lib', undefined)).toBeUndefined();
  });

  it('keeps a package from another index: it is still a published release', () => {
    expect(lock.resolve('pyproject.toml', 'private-dep', undefined)).toBe('2.1.0');
  });

  it('reads a lockfile that holds no package', () => {
    const empty = parsePythonLockfile('poetry.lock', '[metadata]\nlock-version = "2.0"\ncontent-hash = "abc"\n');
    expect(empty.resolve('pyproject.toml', 'certifi', undefined)).toBeUndefined();
  });

  it('refuses a file that is not a Poetry lockfile', () => {
    expect(() => parsePythonLockfile('poetry.lock', 'name = "requests"\n')).toThrow();
  });
});
