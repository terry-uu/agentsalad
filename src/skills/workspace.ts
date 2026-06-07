/**
 * Workspace Manager — 에이전트/채널/타겟 3-depth 격리 파일 공간
 *
 * 멀티채널 + 멀티타겟 구조:
 *   {STORE_DIR}/workspaces/<agent>/                     — 에이전트 워크스페이스 루트
 *   {STORE_DIR}/workspaces/<agent>/_shared/             — 공용 폴더 (모든 채널, 모든 타겟 접근)
 *   {STORE_DIR}/workspaces/<agent>/<channel>/<target>/  — 채널→타겟 개인 폴더 (파일 도구 루트)
 *
 * 커스텀 스킬: {STORE_DIR}/skills/<folder_name>/ — 사용자/LLM 에이전트가 직접 편집하는 스킬 폴더.
 * 크로스 플랫폼: run.sh(macOS/Linux) + run.cmd(Windows) 양쪽 템플릿 생성.
 * 드레싱스토어 연동: 스킬 생성 시 dressing.json 템플릿도 함께 생성하여
 *   폴더를 그대로 .dressing 패키지로 만들어 드레싱스토어에 배포할 수 있도록 한다.
 *   dressing.json에 platforms(지원 OS), dependencies(런타임/패키지/시스템 도구) 포함.
 *
 * 경로 기준: config.ts의 STORE_DIR을 import하여 사용.
 * Electron 패키징 시 AGENTSALAD_STORE_DIR 환경변수로 userData 경로가 주입되므로
 * 앱 업데이트 시에도 사용자 데이터가 보존된다.
 *
 * 폴더명은 folder_name 기준으로 고정되고, 표시명과 분리된다.
 * 인메모리 맵(id → folder_name)으로 경로 해석.
 * 이름 변경 시 물리 폴더도 renameSync으로 추적.
 *
 * File Upload 유틸: uploads/ 저장, .file-cache/ 파싱캐시, 파일명 중복 처리.
 */
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  chmodSync,
  renameSync,
} from 'fs';
import { resolve, join } from 'path';

import { STORE_DIR } from '../config.js';

const WORKSPACES_ROOT = join(STORE_DIR, 'workspaces');
const SKILLS_ROOT = join(STORE_DIR, 'skills');

// ── 인메모리 폴더명 맵 (id → folder_name) ──

const folderNameMap = new Map<string, string>();

/** 서버 시작 시 일괄 등록 */
export function initFolderNames(
  entries: Array<{ id: string; folderName: string }>,
): void {
  for (const e of entries) folderNameMap.set(e.id, e.folderName);
}

export function registerFolderName(id: string, folderName: string): void {
  folderNameMap.set(id, folderName);
}

export function unregisterFolderName(id: string): void {
  folderNameMap.delete(id);
}

/** 맵에서 폴더명 조회. 미등록 시 id 그대로 반환 (하위 호환) */
function resolveFolderName(id: string): string {
  return folderNameMap.get(id) || id;
}

// ── Slug 유틸 ──

/**
 * 이름을 파일시스템 안전한 폴더명으로 변환.
 * 한글/영문/숫자/하이픈/언더스코어 유지, 나머지 제거.
 */
export function toFolderSlug(name: string): string {
  return (
    name
      .trim()
      .replace(/[\/\\:*?"<>|.,;!@#$%^&()=+\[\]{}~`]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^\.+/, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || `unnamed-${Date.now().toString(36)}`
  );
}

/**
 * root 디렉토리 기준으로 충돌 없는 슬러그 반환.
 * 파일시스템 존재 + 인메모리 맵 모두 확인.
 */
export function uniqueFolderSlug(root: string, baseSlug: string): string {
  const mapValues = new Set(folderNameMap.values());
  let slug = baseSlug;
  let counter = 2;
  while (existsSync(join(root, slug)) || mapValues.has(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  return slug;
}

// ── 에이전트 워크스페이스 ──

export function getWorkspacesRoot(): string {
  return WORKSPACES_ROOT;
}

export function getWorkspacePath(agentId: string): string {
  return join(WORKSPACES_ROOT, resolveFolderName(agentId));
}

export function ensureWorkspace(agentId: string): string {
  const wsPath = getWorkspacePath(agentId);
  if (!existsSync(wsPath)) {
    mkdirSync(wsPath, { recursive: true });
  }
  return wsPath;
}

// ── 채널+타겟별 워크스페이스 (멀티채널 + 멀티타겟) ──

/** 에이전트 워크스페이스 내 채널→타겟 전용 서브폴더 경로 */
export function getTargetWorkspacePath(
  agentId: string,
  channelId: string,
  targetFolderRef: string,
): string {
  const channelSlug = resolveFolderName(channelId);
  const targetSlug = resolveFolderName(targetFolderRef);
  return join(getWorkspacePath(agentId), channelSlug, targetSlug);
}

/** 채널→타겟 워크스페이스 + _shared/ 폴더 함께 생성 */
export function ensureTargetWorkspace(
  agentId: string,
  channelId: string,
  targetFolderRef: string,
): string {
  ensureWorkspace(agentId);
  const targetPath = getTargetWorkspacePath(
    agentId,
    channelId,
    targetFolderRef,
  );
  if (!existsSync(targetPath)) mkdirSync(targetPath, { recursive: true });
  const sharedPath = join(getWorkspacePath(agentId), '_shared');
  if (!existsSync(sharedPath)) mkdirSync(sharedPath, { recursive: true });
  return targetPath;
}

export function removeWorkspace(agentId: string): void {
  const wsPath = getWorkspacePath(agentId);
  if (existsSync(wsPath)) {
    rmSync(wsPath, { recursive: true, force: true });
  }
  unregisterFolderName(agentId);
}

/** 채널 이름 변경 시 에이전트 워크스페이스 내 채널 폴더 리네임 */
export function renameChannelFolder(
  agentId: string,
  channelId: string,
  newFolderName: string,
): void {
  const agentWs = getWorkspacePath(agentId);
  const oldSlug = resolveFolderName(channelId);
  const oldPath = join(agentWs, oldSlug);
  const newPath = join(agentWs, newFolderName);
  if (existsSync(oldPath) && oldPath !== newPath) {
    if (!existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }
  }
  registerFolderName(channelId, newFolderName);
}

/** 에이전트 이름 변경 시 워크스페이스 폴더 리네임 */
export function renameWorkspaceFolder(
  agentId: string,
  newFolderName: string,
): void {
  const oldPath = getWorkspacePath(agentId);
  const newPath = join(WORKSPACES_ROOT, newFolderName);
  if (existsSync(oldPath) && oldPath !== newPath) {
    if (!existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }
  }
  registerFolderName(agentId, newFolderName);
}

/**
 * 사용자가 제공한 상대 경로를 워크스페이스 내 절대 경로로 변환.
 * 경로 탈출(path traversal) 시도 시 에러를 throw.
 *
 * _shared/ 경로: agentWorkspacePath가 제공되면 `_shared/...` 접근을 허용.
 * 타겟 폴더에서 상위의 _shared/ 폴더로 안전하게 접근 가능.
 */
export function resolveWorkspacePath(
  workspacePath: string,
  relativePath: string,
  agentWorkspacePath?: string,
): string {
  // _shared/ 프리픽스 → 에이전트 워크스페이스 루트의 _shared/ 폴더로 해석
  if (
    agentWorkspacePath &&
    relativePath.replace(/^[/\\]+/, '').startsWith('_shared')
  ) {
    const sharedRelative = relativePath.replace(/^[/\\]+/, '');
    const normalized = resolve(agentWorkspacePath, sharedRelative);
    const sharedRoot = join(agentWorkspacePath, '_shared');
    if (!normalized.startsWith(sharedRoot)) {
      throw new Error(`Access denied: path escapes _shared boundary`);
    }
    return normalized;
  }

  const normalized = resolve(workspacePath, relativePath);
  if (!normalized.startsWith(workspacePath)) {
    throw new Error(`Access denied: path escapes workspace boundary`);
  }
  return normalized;
}

// ── Custom Skill Script Files ──

export function getSkillsRoot(): string {
  return SKILLS_ROOT;
}

export function getSkillScriptDir(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId));
}

export function getSkillScriptPath(skillId: string): string {
  const dir = join(SKILLS_ROOT, resolveFolderName(skillId));
  if (process.platform === 'win32') {
    const cmdPath = join(dir, 'run.cmd');
    if (existsSync(cmdPath)) return cmdPath;
  }
  return join(dir, 'run.sh');
}

export function skillScriptExists(skillId: string): boolean {
  const dir = join(SKILLS_ROOT, resolveFolderName(skillId));
  return existsSync(join(dir, 'run.sh')) || existsSync(join(dir, 'run.cmd'));
}

export function getSkillSchemaPath(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId), 'schema.json');
}

export function getSkillPromptPath(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId), 'prompt.txt');
}

export function getSkillGuidePath(skillId: string): string {
  return join(SKILLS_ROOT, resolveFolderName(skillId), 'GUIDE.md');
}

/** 스킬 이름 변경 시 폴더 리네임 */
export function renameSkillFolder(
  skillId: string,
  newFolderName: string,
): void {
  const oldPath = getSkillScriptDir(skillId);
  const newPath = join(SKILLS_ROOT, newFolderName);
  if (existsSync(oldPath) && oldPath !== newPath) {
    if (!existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }
  }
  registerFolderName(skillId, newFolderName);
}

/**
 * Scaffold skill directory + template files.
 * Existing files are never overwritten (preserves user/agent edits).
 *
 * Generated files:
 *   run.sh         — Entry point (macOS/Linux)
 *   run.cmd        — Entry point (Windows)
 *   schema.json    — LLM tool input parameter definitions
 *   prompt.txt     — System prompt fragment for the LLM
 *   GUIDE.md       — Comprehensive guide for humans & LLM agents
 */
export function ensureSkillScript(skillId: string, toolName: string): string {
  const dir = getSkillScriptDir(skillId);
  const scriptPath = getSkillScriptPath(skillId);
  const shPath = join(dir, 'run.sh');
  const cmdPath = join(dir, 'run.cmd');
  const schemaPath = getSkillSchemaPath(skillId);
  const promptPath = getSkillPromptPath(skillId);
  const guidePath = getSkillGuidePath(skillId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(shPath)) {
    const shTemplate = `#!/bin/bash
# ${toolName} — Agent Salad Custom Skill
# See GUIDE.md in this folder for detailed instructions.

SKILL_DIR=$(dirname "$0")

echo "TODO: ${toolName} — Edit this file. Read GUIDE.md to get started."
`;
    writeFileSync(shPath, shTemplate, { mode: 0o755 });
    try {
      chmodSync(shPath, 0o755);
    } catch {
      /* chmod not supported */
    }
  }

  if (!existsSync(cmdPath)) {
    const cmdTemplate = `@echo off\r
REM ${toolName} — Agent Salad Custom Skill\r
REM See GUIDE.md in this folder for detailed instructions.\r
\r
set "SKILL_DIR=%~dp0"\r
\r
echo TODO: ${toolName} — Edit this file. Read GUIDE.md to get started.\r
`;
    writeFileSync(cmdPath, cmdTemplate, 'utf-8');
  }

  if (!existsSync(schemaPath)) {
    const schemaTemplate = `[
  {
    "_readme": "This file defines parameters the LLM passes to the tool. Keys starting with _ are ignored.",
    "_format": "{ name, type: string|number|boolean, description }",
    "_delivery": "Delivered to the script via INPUT_<NAME> env vars, INPUT_JSON env var, and stdin JSON",
    "_no_params": "For tools with no parameters, replace this file with an empty array []"
  },
  {
    "name": "query",
    "type": "string",
    "description": "Search query or input value"
  }
]
`;
    writeFileSync(schemaPath, schemaTemplate, 'utf-8');
  }

  if (!existsSync(promptPath)) {
    const promptTemplate = `When the user requests a task related to ${toolName}, use the ${toolName} tool.
Return the result as-is or summarize it for the user.
`;
    writeFileSync(promptPath, promptTemplate, 'utf-8');
  }

  if (!existsSync(guidePath)) {
    writeFileSync(guidePath, buildGuideContent(toolName, skillId), 'utf-8');
  }

  return scriptPath;
}

function buildGuideContent(toolName: string, skillId: string): string {
  return `# ${toolName} — Agent Salad Custom Skill Guide

This guide is for both **humans** and **LLM agents**.
Edit the files in this folder directly, or show this file to an LLM and ask it to implement.

## Folder Structure

\`\`\`
store/skills/${skillId}/
├── run.sh          Entry point (macOS/Linux)
├── run.cmd         Entry point (Windows)
├── schema.json     LLM tool input parameter definitions
├── prompt.txt      System prompt fragment for the LLM
├── GUIDE.md        This file. Implementation guide.
└── (your files)    Scripts, configs, data — add anything you need
\`\`\`

This folder is the skill's project root.
Drop any project here — Node.js, Python, shell scripts, etc.

## Cross-Platform

| Platform | Entry File | Shell |
|----------|-----------|-------|
| macOS / Linux | \`run.sh\` | bash |
| Windows | \`run.cmd\` | cmd.exe |

Keep both files to ensure the skill works on any OS.
For Node.js/Python, put the actual logic in .js/.py files and use run.sh/run.cmd as launchers.

## Runtime Environment

| Item | macOS/Linux | Windows |
|------|-------------|---------|
| Execution | \`bash run.sh\` | \`run.cmd\` |
| Skill folder path | \`SKILL_DIR=$(dirname "$0")\` | \`set "SKILL_DIR=%~dp0"\` |
| cwd (working dir) | Agent workspace (\`store/workspaces/<agent>/\`) | Same |
| Timeout | 30 seconds (default) | Same |
| stdout | Tool response the LLM reads | Same |
| stderr | Sent to LLM on error (debug logs) | Same |
| exit code | 0 = success, non-zero = error | Same |

### Two Path Roles

| Variable | Path | Purpose |
|----------|------|---------|
| \`SKILL_DIR\` | \`store/skills/<skill>/\` | **Code + config** (immutable). run.sh, collect.js, config, etc. |
| \`$PWD\` / \`%CD%\` (cwd) | \`store/workspaces/<agent>/\` | **Output + temp data**. Accessible via read_file/list_files |

> **Key principle**: All output files **must** be saved to cwd (workspace), not \`SKILL_DIR\`.
> Files saved to \`SKILL_DIR\` are invisible to the agent.
> When multiple agents share one skill, each agent's output is isolated in its own workspace.

Everything printed to stdout is sent to the LLM as the tool response.
Save large results to workspace files and print only a summary to stdout.

## Input (LLM → Script)

Parameters defined in \`schema.json\` are delivered three ways:

1. **Env var** \`INPUT_<NAME>\` — parameter name uppercased
   e.g. \`"query"\` in schema → bash: \`$INPUT_QUERY\`, cmd: \`%INPUT_QUERY%\`
2. **Env var** \`INPUT_JSON\` — full input as a JSON string
3. **stdin** — piped JSON

For tools with no parameters: set \`schema.json\` to an empty array \`[]\`.

## Writing prompt.txt

\`prompt.txt\` is automatically injected into the LLM's system prompt.
Its job is to tell the LLM **when** and **how** to use this tool.

**Good example:**
\`\`\`
When the user asks to summarize recent videos from a YouTube channel,
use the ${toolName} tool. The lookback_hours parameter controls the
time range. Results are in markdown format.
\`\`\`

**Key points:**
- **When** to use it (trigger conditions)
- **How** to fill parameters
- **What** the result looks like
- **Expected runtime** (if long, LLM can warn the user upfront)
- Do NOT describe internal implementation (LLM doesn't need it)

> **Timeout info**: The system automatically appends \`[Timeout for this tool: Ns]\` to the prompt.
> You don't need to specify timeout in prompt.txt, but if expected runtime exceeds the default 30s,
> increase the timeout in the Web UI and note it (e.g. "This tool takes ~2 minutes").

## Examples

### A. Node.js — Cross-platform (recommended)

**run.sh** (macOS/Linux):
\`\`\`bash
SKILL_DIR=$(dirname "$0")
export OUTPUT_DIR="$PWD/collect-output"
mkdir -p "$OUTPUT_DIR"
node "$SKILL_DIR/collect.js" 2>/dev/null
cat "$OUTPUT_DIR/summary.md"
\`\`\`

**run.cmd** (Windows):
\`\`\`cmd
@echo off
set "SKILL_DIR=%~dp0"
set "OUTPUT_DIR=%CD%\\collect-output"
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
node "%SKILL_DIR%collect.js" 2>nul
type "%OUTPUT_DIR%\\summary.md"
\`\`\`

### B. Python + Parameters
\`\`\`bash
SKILL_DIR=$(dirname "$0")
python3 "$SKILL_DIR/main.py" --query "$INPUT_QUERY" --output-dir "$PWD"
\`\`\`

### C. Simple API Call (no file output)
\`\`\`bash
curl -s "https://api.example.com/data?q=$INPUT_QUERY"
\`\`\`

## Important Notes

### Timeout (30s default)
Scripts are killed after 30 seconds by default.
Use caching or optimization for long-running tasks.

### Cron + Long Scripts = Process Proliferation
Cron invokes the skill on every trigger. If it doesn't finish within the timeout,
zombie processes accumulate. Keep cron-linked skills fast.

### No Background Processes
Do not detach child processes with \`nohup\`, \`&\`, or \`daemon\`.
Children survive after the script exits and consume resources.

### stdout Management
Send debug logs to stderr: bash \`echo "debug" >&2\`, cmd \`echo debug 1>&2\`
Everything in stdout consumes LLM response tokens.
Dumping large files via cat/type wastes tokens and risks context overflow.

### No Interactive Input
\`read\`, \`input()\`, \`set /p\` etc. will hang.
All input must come via env vars or stdin JSON.

### Install Dependencies Upfront
Run \`pip install\`, \`npm install\`, etc. before the skill executes.
Installing inside the script every time will hit the timeout.

`;
}

/** 스킬 삭제 시 스크립트 디렉토리 제거 */
export function removeSkillScript(skillId: string): void {
  const dir = getSkillScriptDir(skillId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  unregisterFolderName(skillId);
}

// ── File Upload 유틸 ──

const UPLOADS_DIR = 'uploads';

/** 워크스페이스 내 uploads/ 폴더 경로 반환 (없으면 생성) */
export function getUploadsPath(workspacePath: string): string {
  const dir = join(workspacePath, UPLOADS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 디렉토리 내 충돌 없는 파일명 반환.
 * report.pdf → report.pdf (최초), report-2.pdf (중복), report-3.pdf ...
 */
export function uniqueFilename(dir: string, filename: string): string {
  if (!existsSync(join(dir, filename))) return filename;
  const dotIdx = filename.lastIndexOf('.');
  const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';
  let counter = 2;
  while (existsSync(join(dir, `${base}-${counter}${ext}`))) counter++;
  return `${base}-${counter}${ext}`;
}

/**
 * 첨부파일을 워크스페이스 uploads/에 저장.
 * 중복 파일명 자동 처리. 저장된 상대 경로 반환 (예: "uploads/report.pdf").
 */
export function saveUploadedFile(
  workspacePath: string,
  filename: string,
  buffer: Buffer,
): string {
  const uploadsDir = getUploadsPath(workspacePath);
  const safeName = uniqueFilename(uploadsDir, filename);
  const fullPath = join(uploadsDir, safeName);
  writeFileSync(fullPath, buffer);
  return fullPath;
}
