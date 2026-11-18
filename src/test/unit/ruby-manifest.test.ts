import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/analyze';
import { dependencyAtOffset, manifestAdapterForPath } from '../../core/manifest';
import { parseNotes } from '../../core/parseNotes';
import { isRubyLockfilePath, parseRubyLockfile, rubyLockfileFor } from '../../core/ruby-lockfile';
import { extractRubyDependencies, rubyPinnedVersion, uniqueRubyDependencies } from '../../core/ruby-manifest';

describe('Ruby manifest matching', () => {
  it('matches Bundler and RubyGems manifests but not lockfiles', () => {
    expect(manifestAdapterForPath('/repo/Gemfile')?.kind).toBe('ruby');
    expect(manifestAdapterForPath('/repo/gems.rb')?.kind).toBe('ruby');
    expect(manifestAdapterForPath('/repo/example.gemspec')?.kind).toBe('ruby');
    expect(manifestAdapterForPath('/repo/Gemfile.lock')).toBeUndefined();
    expect(manifestAdapterForPath('/repo/gems.locked')).toBeUndefined();
  });
});

describe('Gemfile dependencies', () => {
  const gemfile = `source "https://rubygems.org"

gem "rails", "~> 8.0"
gem("puma", ">= 6")

group :development, :test do
  gem "rspec"
  gem "debug", platforms: [:mri, :windows]
end

platforms(:jruby) do
  gem "jruby-openssl", group: :runtime
end

source "https://gems.example.test" do
  git "https://example.test/repo.git" do
    gem "private_gem", :groups => [:production, :test]
  end
end

path "components" do
  gem "local_component"
end
`;

  it('extracts literal calls with group and platform scopes', () => {
    expect(extractRubyDependencies(gemfile).map((dependency) => `${dependency.scope}:${dependency.noteKey}`)).toEqual([
      'default:rails',
      'default:puma',
      'development,test:rspec',
      'development,test@mri,windows:debug',
      'runtime@jruby:jruby-openssl',
      'production,test:private_gem',
      'default:local_component',
    ]);
  });

  it('returns exact clickable name and icon ranges', () => {
    const dependencies = extractRubyDependencies(gemfile);
    for (const dependency of dependencies) {
      expect(gemfile.slice(
        dependency.primaryRange.offset,
        dependency.primaryRange.offset + dependency.primaryRange.length,
      )).toBe(dependency.displayName);
      expect(gemfile.slice(
        dependency.iconRange.offset,
        dependency.iconRange.offset + dependency.iconRange.length,
      )).toBe('gem');
      expect(dependencyAtOffset(dependencies, dependency.sourceRanges[0]!.offset + 1)).toBe(dependency);
    }
  });

  it('ignores comments, literals, dynamic names, definitions and unsupported directives', () => {
    const text = String.raw`# gem "commented"
message = "gem \"inside_string\""
pattern = /gem "inside_regex"/
percent = %q{gem "inside_percent"}
document = <<~TEXT
  gem "inside_heredoc"
TEXT
=begin
gem "inside_block_comment"
=end
name = "dynamic"
gem name
gem "dynamic-#{ENV.fetch('TARGET')}"
eval_gemfile "other.gemfile"
gemspec

def dependencies
  gem "inside_method"
end

class Recipe
  gem "inside_class"
end

gem "real"
`;
    expect(extractRubyDependencies(text).map((dependency) => dependency.noteKey)).toEqual(['real']);
  });

  it('keeps declarations found before malformed input', () => {
    expect(extractRubyDependencies('gem "first"\ngem "unterminated\n')).toEqual([
      expect.objectContaining({ noteKey: 'first', scope: 'default' }),
    ]);
  });

  it('keeps the requirement each gem writes, and where it comes from when not rubygems.org', () => {
    expect(Object.fromEntries(extractRubyDependencies(gemfile).map((dependency) => [dependency.noteKey, dependency.versionSpec]))).toEqual({
      'rails': '~> 8.0',
      'puma': '>= 6',
      'rspec': undefined,
      'debug': undefined,
      'jruby-openssl': undefined,
      // The innermost block names the source: the git checkout, inside a private server's block.
      'private_gem': 'git+https://example.test/repo.git',
      'local_component': 'file:components',
    });
    const text = `gem "rails", "~> 7.1", ">= 7.1.2"
gem "pinned", "1.2.3"
gem "forked", git: "https://example.test/forked.git", branch: "main"
gem "hub", github: "acme/hub"
gem "local", path: "../local"
gem "mirrored", "~> 1.0", source: "https://gems.example.test"
gem "official", "~> 1.0", source: "https://rubygems.org"
source "https://gems.example.test" do
  gem "private", "~> 2.0"
end
`;
    expect(Object.fromEntries(extractRubyDependencies(text).map((dependency) => [dependency.noteKey, dependency.versionSpec]))).toEqual({
      rails: '~> 7.1, >= 7.1.2',
      pinned: '1.2.3',
      forked: 'git+https://example.test/forked.git',
      hub: 'git+https://github.com/acme/hub',
      local: 'file:../local',
      mirrored: 'registry:https://gems.example.test',
      official: '~> 1.0',
      private: 'registry:https://gems.example.test',
    });
  });
});

describe('rubyPinnedVersion', () => {
  it('names the release of an exact requirement, bare or with =', () => {
    expect(rubyPinnedVersion('1.2.3')).toBe('1.2.3');
    expect(rubyPinnedVersion('= 7.1.2')).toBe('7.1.2');
    expect(rubyPinnedVersion('1.0.0.rc1')).toBe('1.0.0.rc1');
    for (const spec of ['~> 7.1', '>= 6', '~> 7.1, >= 7.1.2', 'git+https://x', undefined]) {
      expect(rubyPinnedVersion(spec), String(spec)).toBeUndefined();
    }
  });
});

describe('Gemfile.lock', () => {
  const lock = [
    'GIT',
    '  remote: https://example.test/forked.git',
    '  revision: 0123abc',
    '  specs:',
    '    forked (2.0.0)',
    '',
    'PATH',
    '  remote: ../local',
    '  specs:',
    '    local (0.1.0)',
    '',
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    nokogiri (1.15.4-x86_64-linux)',
    '      racc (~> 1.4)',
    '    nokogiri (1.15.4-arm64-darwin)',
    '    rails (7.1.2)',
    '      actioncable (= 7.1.2)',
    '    sorbet (0.5.11000.rc1)',
    '',
    'GEM',
    '  remote: https://gems.example.test/',
    '  specs:',
    '    private (2.0.1)',
    '',
    'PLATFORMS',
    '  x86_64-linux',
    '',
    'DEPENDENCIES',
    '  rails (~> 7.1)',
  ].join('\n');
  const parsed = parseRubyLockfile('Gemfile.lock', lock);

  it('gives each rubygems.org gem its locked version, without the platform', () => {
    expect(parsed.resolve('Gemfile', 'rails', '~> 7.1')).toBe('7.1.2');
    expect(parsed.resolve('Gemfile', 'nokogiri', undefined)).toBe('1.15.4');
    expect(parsed.resolve('Gemfile', 'sorbet', undefined)).toBe('0.5.11000.rc1');
    // A dependency of a gem, indented deeper, is not a gem of its own here.
    expect(parsed.resolve('Gemfile', 'racc', undefined)).toBeUndefined();
  });

  it('gives none for a git, path or private-server gem', () => {
    expect(parsed.resolve('Gemfile', 'forked', 'git+https://example.test/forked.git')).toBeUndefined();
    expect(parsed.resolve('Gemfile', 'local', 'file:../local')).toBeUndefined();
    expect(parsed.resolve('Gemfile', 'private', '~> 2.0')).toBeUndefined();
  });

  it('finds the lockfile beside the Gemfile or gems.rb, and refuses what is not one', () => {
    expect(isRubyLockfilePath('app/Gemfile.lock')).toBe(true);
    expect(isRubyLockfilePath('app/gems.locked')).toBe(true);
    expect(rubyLockfileFor('app/Gemfile', new Set(['app/Gemfile.lock']))).toBe('app/Gemfile.lock');
    expect(() => parseRubyLockfile('Gemfile.lock', '{"packages": []}')).toThrow();
  });
});

describe('gemspec dependencies', () => {
  const gemspec = `Gem::Specification.new do |spec|
  spec.add_dependency "rack", ">= 3"
  spec.add_runtime_dependency("zeitwerk", "~> 2.6")
  spec.add_development_dependency 'rspec'
  other.add_dependency "wrong_receiver"

  def spec.dynamic_dependencies
    spec.add_dependency "inside_method"
  end
end

outside.add_dependency "outside_block"
`;

  it('extracts runtime and development dependencies from the specification receiver', () => {
    expect(extractRubyDependencies(gemspec, '/repo/example.gemspec').map((dependency) =>
      `${dependency.scope}:${dependency.noteKey}`)).toEqual([
      'runtime:rack',
      'runtime:zeitwerk',
      'development:rspec',
    ]);
  });

  it('anchors icons at the gemspec dependency method', () => {
    for (const dependency of extractRubyDependencies(gemspec, 'example.gemspec')) {
      expect(gemspec.slice(
        dependency.primaryRange.offset,
        dependency.primaryRange.offset + dependency.primaryRange.length,
      )).toBe(dependency.noteKey);
      expect(gemspec.slice(
        dependency.iconRange.offset,
        dependency.iconRange.offset + dependency.iconRange.length,
      )).toMatch(/^add_(?:runtime_|development_)?dependency$/);
    }
  });
});

describe('Ruby note identity', () => {
  it('is case-sensitive and keeps dash and underscore distinct', () => {
    const dependencies = extractRubyDependencies('gem "rack"\ngem "my_gem"\ngem "my-gem"\n');
    const notes = parseNotes('---\nformat: dependency-notes/2\necosystem: ruby\n---\n# Dependency Notes\n\n## Rack\n\nWrong case.\n\n## my_gem\n\nUnderscore.\n');
    const result = analyze(dependencies, notes);
    expect(result.documented.map((dependency) => dependency.noteKey)).toEqual(['my_gem']);
    expect(result.undocumented.map((dependency) => dependency.noteKey)).toEqual(['rack', 'my-gem']);
  });

  it('deduplicates aggregate views by exact gem name', () => {
    const dependencies = [
      ...extractRubyDependencies('gem "rack"\ngem "Rack"\n'),
      ...extractRubyDependencies('Gem::Specification.new do |s|\n s.add_dependency "rack"\nend\n', 'x.gemspec'),
    ];
    expect(uniqueRubyDependencies(dependencies).map((dependency) => dependency.noteKey)).toEqual(['rack', 'Rack']);
  });
});
