# gdelt-mcp-server - Directory Structure

Generated on: 2026-09-24 19:49:01

```text
gdelt-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   ├── tool-defs-analysis/
│   │   └── SKILL.md
│   └── README.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-coverage-breakdown.tool.ts
│   │       │   ├── get-coverage-timeline.tool.ts
│   │       │   ├── get-tone-distribution.tool.ts
│   │       │   ├── get-tv-clips.tool.ts
│   │       │   ├── get-tv-context.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── list-tv-stations.tool.ts
│   │       │   ├── search-articles.tool.ts
│   │       │   ├── search-themes.tool.ts
│   │       │   └── search-tv.tool.ts
│   │       ├── date-range.ts
│   │       ├── markdown-escape.ts
│   │       └── response-budget.ts
│   ├── services/
│   │   └── gdelt/
│   │       ├── date-resolution.ts
│   │       ├── gdelt-doc-service.ts
│   │       ├── gdelt-fetch.ts
│   │       ├── gdelt-pacer.ts
│   │       ├── gdelt-theme-service.ts
│   │       ├── gdelt-tv-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── gkg-themes-excerpt.txt
│   │   └── tv-station-catalog.json
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── date-resolution.test.ts
│   │   ├── gdelt-doc-service.test.ts
│   │   ├── gdelt-fetch-retry.test.ts
│   │   ├── gdelt-fetch.test.ts
│   │   ├── gdelt-pacer.test.ts
│   │   ├── gdelt-theme-service.test.ts
│   │   └── gdelt-tv-service.test.ts
│   └── tools/
│       ├── date-range.test.ts
│       ├── error-propagation.test.ts
│       ├── get-coverage-breakdown.tool.test.ts
│       ├── get-coverage-timeline.tool.test.ts
│       ├── get-tone-distribution.tool.test.ts
│       ├── get-tv-clips.tool.test.ts
│       ├── get-tv-context.tool.test.ts
│       ├── input-validation.test.ts
│       ├── list-tv-stations.tool.test.ts
│       ├── markdown-escape.test.ts
│       ├── markdown-render.ts
│       ├── response-budget.test.ts
│       ├── search-articles.tool.test.ts
│       ├── search-themes.tool.test.ts
│       ├── search-tv.tool.test.ts
│       ├── security.test.ts
│       ├── theme-operator-hints.test.ts
│       └── tool-surface.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
