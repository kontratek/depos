export type Eol = '\n' | '\r\n';

export interface LineRange {
  /** inclusive, 0-based */
  startLine: number;
  /** inclusive, 0-based */
  endLine: number;
}

export interface NoteSection {
  /** Trimmed heading text after "## " — the package name as written. */
  name: string;
  headingLine: number;
  /** First body line (0-based, may equal bodyEnd when body is empty). */
  bodyStart: number;
  /** Exclusive end line of the body. */
  bodyEnd: number;
  /**
   * Line of the first `### Agent notes` sub-heading (case-insensitive, outside
   * fences). Everything from bodyStart up to it is the human-written layer;
   * everything after it is the agent-written layer.
   */
  agentHeadingLine?: number;
  /**
   * Line of the first `### Generated` sub-heading. Reserved for a future
   * version: preserved verbatim, never edited, no UI yet.
   */
  generatedHeadingLine?: number;
}

export interface NotesProblem {
  kind: 'duplicateSection';
  name: string;
  line: number;
  firstLine: number;
}

export interface Frontmatter extends LineRange {
  /** `format:` — the format version this file was written for. */
  formatVersion?: string;
  /** `lang:` — language the values are written in (keys are always English). */
  lang?: string;
  /** `ecosystem:` — required by dependency-notes/2 files. */
  ecosystem?: ManifestKind;
}

export interface NotesFileModel {
  eol: Eol;
  hadBom: boolean;
  lines: string[];
  frontmatter?: Frontmatter;
  aiComment?: LineRange;
  titleLine?: number;
  /** Free text between the header block and the first section (verbatim, may be empty). */
  intro: LineRange | undefined;
  sections: NoteSection[];
  problems: NotesProblem[];
}

export type ManifestKind = 'npm' | 'cargo' | 'maven' | 'gradle' | 'mix' | 'gleam' | 'zig' | 'python' | 'ruby' | 'go' | 'nuget' | 'vcpkg' | 'conan' | 'composer';

export interface SourceRange {
  offset: number;
  length: number;
}

/** A direct dependency declaration in any supported manifest. */
export interface DependencyEntry {
  /** Stable section key in DEPENDENCY-NOTES.md. */
  noteKey: string;
  /** Human-facing identifier. Usually the same as noteKey. */
  displayName: string;
  /** Manifest-specific dependency scope. */
  scope: string;
  /**
   * The version as the manifest writes it. Every reader gives one where the manifest
   * has it (Maven with the pom's properties filled in; vcpkg `>=1.2` for a minimum,
   * Conan `1.2@user/channel` for a package outside ConanCenter). A dependency that is
   * not a registry release under its own name is written with a prefix, as npm does
   * (`git+…`, `file:…`, `workspace:…`; Cargo, Mix and Go also `package:…` for a renamed
   * package, and Cargo and Mix `registry:…` for another registry; Maven `file:…` for a
   * `system` jar; Zig its URL), so a consumer can leave it out of registry checks.
   */
  versionSpec?: string;
  /**
   * The version the build installs, when the manifest decides it without a lock file
   * and `versionSpec` alone does not say it: vcpkg's baseline, or the tag of a Zig
   * archive its hash pins. A lock file's answer comes first.
   */
  installedVersion?: string;
  /** Range used for line decorations and placement. */
  primaryRange: SourceRange;
  /** Range before which the Depos icon is rendered. */
  iconRange: SourceRange;
  /** Every source range that should respond to hover/navigation. */
  sourceRanges: readonly SourceRange[];
  /** @deprecated Compatibility alias for noteKey. */
  name: string;
  /** @deprecated Compatibility alias for scope. */
  section: string;
  /** @deprecated Compatibility alias for primaryRange.offset. */
  keyOffset: number;
  /** @deprecated Compatibility alias for primaryRange.length. */
  keyLength: number;
}

/** Kept while editor integrations migrate from the original npm-only name. */
export type DepEntry = DependencyEntry;
