export type LanguageMapping = {
  id: string;
  label: string;
  extensions?: string[];
  fileNames?: string[];
};

// 这些 language ID 在随包加载的 Monaco basic-languages 中真实注册。
export const languageMappings: LanguageMapping[] = [
  { id: "abap", label: "ABAP", extensions: [".abap"] },
  { id: "apex", label: "Apex", extensions: [".cls", ".trigger"] },
  { id: "bat", label: "Batch", extensions: [".bat", ".cmd"] },
  { id: "bicep", label: "Bicep", extensions: [".bicep"] },
  { id: "clojure", label: "Clojure", extensions: [".clj", ".cljs", ".cljc"] },
  { id: "coffee", label: "CoffeeScript", extensions: [".coffee"] },
  { id: "cpp", label: "C / C++", extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"] },
  { id: "csharp", label: "C#", extensions: [".cs"] },
  { id: "cypher", label: "Cypher", extensions: [".cql"] },
  { id: "dart", label: "Dart", extensions: [".dart"] },
  { id: "dockerfile", label: "Dockerfile", fileNames: ["dockerfile"] },
  { id: "elixir", label: "Elixir", extensions: [".ex", ".exs"] },
  { id: "fsharp", label: "F#", extensions: [".fs", ".fsi", ".fsx"] },
  { id: "go", label: "Go", extensions: [".go"] },
  { id: "graphql", label: "GraphQL", extensions: [".graphql", ".gql"] },
  { id: "hcl", label: "HCL / Terraform", extensions: [".hcl", ".tf", ".tfvars"] },
  { id: "html", label: "HTML", extensions: [".html", ".htm"] },
  { id: "ini", label: "INI / Properties", extensions: [".ini", ".properties"], fileNames: [".editorconfig"] },
  { id: "java", label: "Java", extensions: [".java"] },
  { id: "javascript", label: "JavaScript", extensions: [".js", ".mjs", ".cjs", ".jsx"] },
  { id: "julia", label: "Julia", extensions: [".jl"] },
  { id: "kotlin", label: "Kotlin", extensions: [".kt", ".kts"] },
  { id: "less", label: "Less", extensions: [".less"] },
  { id: "lua", label: "Lua", extensions: [".lua"] },
  { id: "markdown", label: "Markdown", extensions: [".md", ".markdown"] },
  { id: "mdx", label: "MDX", extensions: [".mdx"] },
  { id: "mips", label: "MIPS Assembly", extensions: [".mips", ".asm"] },
  { id: "mysql", label: "MySQL", extensions: [".mysql"] },
  { id: "objective-c", label: "Objective-C", extensions: [".m", ".mm"] },
  { id: "pascal", label: "Pascal", extensions: [".pas", ".pp"] },
  { id: "perl", label: "Perl", extensions: [".pl", ".pm"] },
  { id: "php", label: "PHP", extensions: [".php", ".phtml"] },
  { id: "powershell", label: "PowerShell", extensions: [".ps1", ".psm1", ".psd1"] },
  { id: "protobuf", label: "Protocol Buffers", extensions: [".proto"] },
  { id: "python", label: "Python", extensions: [".py", ".pyw", ".pyi"] },
  { id: "r", label: "R", extensions: [".r", ".R"] },
  { id: "redis", label: "Redis", extensions: [".redis"] },
  { id: "ruby", label: "Ruby", extensions: [".rb", ".rake", ".gemspec"] },
  { id: "rust", label: "Rust", extensions: [".rs"] },
  { id: "scala", label: "Scala", extensions: [".scala", ".sc"] },
  { id: "scheme", label: "Scheme", extensions: [".scm", ".ss"] },
  { id: "scss", label: "SCSS", extensions: [".scss"] },
  { id: "shell", label: "Shell", extensions: [".sh", ".bash", ".zsh", ".fish"] },
  { id: "solidity", label: "Solidity", extensions: [".sol"] },
  { id: "sql", label: "SQL", extensions: [".sql"] },
  { id: "swift", label: "Swift", extensions: [".swift"] },
  { id: "systemverilog", label: "SystemVerilog", extensions: [".sv", ".svh"] },
  { id: "tcl", label: "Tcl", extensions: [".tcl"] },
  { id: "typescript", label: "TypeScript", extensions: [".ts", ".mts", ".cts", ".tsx"] },
  { id: "vb", label: "Visual Basic", extensions: [".vb"] },
  { id: "xml", label: "XML", extensions: [".xml", ".svg", ".xsd"] },
  { id: "yaml", label: "YAML", extensions: [".yaml", ".yml"] },
  { id: "json", label: "JSON", extensions: [".json", ".jsonc"] },
  { id: "css", label: "CSS", extensions: [".css"] },
  { id: "scss", label: "SCSS", extensions: [".scss"] },
  { id: "pgsql", label: "PostgreSQL", extensions: [".pgsql"] },
  { id: "redshift", label: "Redshift SQL", extensions: [".redshift"] },
  { id: "solidity", label: "Solidity", extensions: [".sol"] },
  { id: "apex", label: "Apex", extensions: [".apex"] },
  { id: "razor", label: "Razor", extensions: [".cshtml", ".razor"] },
  { id: "pug", label: "Pug", extensions: [".pug"] },
  { id: "handlebars", label: "Handlebars", extensions: [".hbs", ".handlebars"] },
  { id: "liquid", label: "Liquid", extensions: [".liquid"] },
  { id: "restructuredtext", label: "reStructuredText", extensions: [".rst"] },
  { id: "wgsl", label: "WGSL", extensions: [".wgsl"] },
  { id: "typespec", label: "TypeSpec", extensions: [".tsp"] },
  { id: "plaintext", label: "纯文本" },
];

export type RegisteredLanguage = { id: string; extensions?: string[]; aliases?: string[] };

export function getLanguageForFile(
  filePath: string,
  registered: ReadonlySet<string>,
): string {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  const byName = languageMappings.find((mapping) => mapping.fileNames?.some((value) => value.toLowerCase() === name));
  if (byName && registered.has(byName.id)) return byName.id;
  const matches = languageMappings
    .filter((mapping) => mapping.extensions?.some((extension) => name.endsWith(extension.toLowerCase())))
    .sort((left, right) => (right.extensions?.reduce((length, extension) => Math.max(length, extension.length), 0) ?? 0)
      - (left.extensions?.reduce((length, extension) => Math.max(length, extension.length), 0) ?? 0));
  const selected = matches.find((mapping) => registered.has(mapping.id));
  return selected?.id ?? "plaintext";
}

const verifiedMonacoLanguageIds = new Set(languageMappings.map((mapping) => mapping.id));

export function resolveEditorLanguage(filePath: string) {
  return getLanguageForFile(filePath, verifiedMonacoLanguageIds);
}

export function getRegisteredLanguageReport(languages: readonly RegisteredLanguage[]) {
  const registered = new Set(languages.map((language) => language.id));
  const candidateIds = [...new Set(languageMappings.map((mapping) => mapping.id).filter((id) => id !== "plaintext"))];
  const registeredIds = candidateIds.filter((id) => registered.has(id));
  return {
    registeredIds,
    registeredCount: registeredIds.length,
    missingIds: candidateIds.filter((id) => !registered.has(id)),
  };
}
