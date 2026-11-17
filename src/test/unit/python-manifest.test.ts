import { describe, expect, it } from 'vitest';
import { manifestAdapterForPath } from '../../core/manifest';
import {
  extractPyprojectDependencies,
  extractRequirementsDependencies,
  normalizePythonPackageName,
  pythonPinnedVersion,
} from '../../core/python-manifest';

describe('Python manifest matching', () => {
  it('matches pyproject and common requirements layouts', () => {
    expect(manifestAdapterForPath('/repo/pyproject.toml')?.kind).toBe('python');
    expect(manifestAdapterForPath('/repo/requirements-dev.txt')?.kind).toBe('python');
    expect(manifestAdapterForPath('/repo/requirements/docs.txt')?.kind).toBe('python');
    expect(manifestAdapterForPath('/repo/dependencies.txt')).toBeUndefined();
    expect(manifestAdapterForPath('/repo/requirements.in')).toBeUndefined();
  });
});

describe('pyproject.toml dependencies', () => {
  const pyproject = `[build-system]
requires = ["setuptools>=68", "wheel"]

[project]
dependencies = [
  "Requests[security]>=2.31; python_version >= '3.10'",
  "importlib_metadata @ https://example.test/importlib.whl",
]

[project.optional-dependencies]
docs = ["Sphinx>=7"]

[dependency-groups]
test = [
  "pytest>=8",
  { include-group = "coverage" },
]

[tool.poetry.dependencies]
python = "^3.12"
Django = "^5"
local_lib = { path = "../local-lib" }

[tool.poetry.dev-dependencies]
Black = "^24"

[tool.poetry.group.lint.dependencies]
Ruff = "^0.9"

[tool.uv]
dev-dependencies = ["mypy>=1"]

[tool.uv.sources]
requests = { git = "https://example.test/requests.git" }
`;

  it('extracts standards, build, Poetry, and uv declarations with stable scopes', () => {
    expect(extractPyprojectDependencies(pyproject).map((dep) => `${dep.scope}:${dep.noteKey}`)).toEqual([
      'build-system:setuptools',
      'build-system:wheel',
      'project:requests',
      'project:importlib-metadata',
      'extra:docs:sphinx',
      'group:test:pytest',
      'poetry:main:django',
      'poetry:main:local-lib',
      'poetry:dev:black',
      'poetry:group:lint:ruff',
      'uv:dev:mypy',
    ]);
  });

  it('keeps declared spelling while using canonical note keys and source ranges', () => {
    const dependencies = extractPyprojectDependencies(pyproject);
    const requests = dependencies.find((dep) => dep.noteKey === 'requests')!;
    expect(requests.displayName).toBe('Requests');
    expect(pyproject.slice(requests.primaryRange.offset, requests.primaryRange.offset + requests.primaryRange.length))
      .toBe('Requests');
    const django = dependencies.find((dep) => dep.noteKey === 'django')!;
    expect(pyproject.slice(django.primaryRange.offset, django.primaryRange.offset + django.primaryRange.length))
      .toBe('Django');
  });

  it('fails safely on irrelevant and malformed declarations', () => {
    expect(extractPyprojectDependencies('[project]\ndependencies = [')).toEqual([]);
    expect(extractPyprojectDependencies('[tool.uv.sources]\nfoo = { path = "../foo" }')).toEqual([]);
  });

  it('keeps the version each declaration writes, without extras or markers', () => {
    expect(Object.fromEntries(extractPyprojectDependencies(pyproject).map((dep) => [`${dep.scope}:${dep.noteKey}`, dep.versionSpec]))).toEqual({
      'build-system:setuptools': '>=68',
      'build-system:wheel': undefined,
      'project:requests': '>=2.31',
      'project:importlib-metadata': '@ https://example.test/importlib.whl',
      'extra:docs:sphinx': '>=7',
      'group:test:pytest': '>=8',
      // Poetry's own syntax, as written; a path dependency has no version.
      'poetry:main:django': '^5',
      'poetry:main:local-lib': undefined,
      'poetry:dev:black': '^24',
      'poetry:group:lint:ruff': '^0.9',
      'uv:dev:mypy': '>=1',
    });
    expect(extractPyprojectDependencies('[tool.poetry.dependencies]\nflask = { version = "2.0.1", extras = ["async"] }')[0]!.versionSpec).toBe('2.0.1');
    expect(extractPyprojectDependencies('[project]\ndependencies = ["legacy (>=1.0)"]')[0]!.versionSpec).toBe('>=1.0');
  });
});

describe('pythonPinnedVersion', () => {
  it('names the release of an exact pin', () => {
    expect(pythonPinnedVersion('==2.0.1')).toBe('2.0.1');
    expect(pythonPinnedVersion(' == 2.0.1 ')).toBe('2.0.1');
    expect(pythonPinnedVersion('===2.0.1')).toBe('2.0.1');
    expect(pythonPinnedVersion('==1!2.0rc1+cpu')).toBe('1!2.0rc1+cpu');
  });

  it('names none for what can install more than one release', () => {
    for (const spec of ['>=2.0', '==2.*', '==2.0.1,!=2.0.2', '~=2.0', '^2.0', '@ https://example.test/x.whl', '', undefined]) {
      expect(pythonPinnedVersion(spec)).toBeUndefined();
    }
  });
});

describe('pip requirements dependencies', () => {
  const requirements = `# application dependencies
Requests[security]>=2.31 ; python_version >= "3.10"
urllib3 @ https://example.test/urllib3.whl --hash=sha256:abc
-e git+https://example.test/acme.git#egg=Acme_Plugin
-r base.txt
--constraint constraints.txt
--index-url https://example.test/simple
./local-project
http://example.test/unnamed.whl
typing_extensions==4.12 \\
  --hash=sha256:def
`;

  it('extracts named requirements and ignores directives and unnamed paths', () => {
    expect(extractRequirementsDependencies(requirements, 'requirements/dev.txt')
      .map((dep) => `${dep.scope}:${dep.noteKey}`)).toEqual([
      'requirements/dev.txt:requests',
      'requirements/dev.txt:urllib3',
      'requirements/dev.txt:acme-plugin',
      'requirements/dev.txt:typing-extensions',
    ]);
  });

  it('keeps a named requirement\'s version, without options, and none for a checkout', () => {
    expect(Object.fromEntries(extractRequirementsDependencies(requirements).map((dep) => [dep.noteKey, dep.versionSpec]))).toEqual({
      'requests': '>=2.31',
      'urllib3': '@ https://example.test/urllib3.whl',
      'acme-plugin': undefined,
      'typing-extensions': '==4.12',
    });
    expect(extractRequirementsDependencies('flask==2.0.1\nnumpy\n')[0]!.versionSpec).toBe('==2.0.1');
    expect(extractRequirementsDependencies('flask==2.0.1\nnumpy\n')[1]!.versionSpec).toBeUndefined();
  });

  it('retains offsets across comments and continuations', () => {
    for (const dependency of extractRequirementsDependencies(requirements)) {
      expect(requirements.slice(dependency.primaryRange.offset, dependency.primaryRange.offset + dependency.primaryRange.length))
        .toBe(dependency.displayName);
    }
  });

  it('normalizes Python distribution names', () => {
    expect(normalizePythonPackageName('Importlib_Metadata')).toBe('importlib-metadata');
    expect(normalizePythonPackageName('zope.interface')).toBe('zope-interface');
  });
});
