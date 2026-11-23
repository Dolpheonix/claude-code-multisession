# Claude Code Multi-Session Monitor

여러 Claude Code 세션을 한꺼번에 지켜보면서, 각 세션이 어떤 파일을 읽고 고쳤는지 그려 줍니다. 여러 세션이 함께 건드린 파일은 강조되므로, 각 브랜치를 머지했을 때 어디에 영향이 갈지 미리 볼 수 있습니다.

**브랜치 1개 = 세션 1개** 방식으로 일할 때를 위해 만들었습니다.

- **세션, 충돌, 그래프**: 세션마다 건드린 파일과, 세션끼리 겹치는 부분
- **허가 요청**: 도구 실행 승인을 기다리는 세션
- **지식 정리(wrap-up)**: 알게 된 것을 아직 CLAUDE.md에 적지 않은 세션, 그리고 그 일을 해 주는 `/wrap-up` 스킬
- **스킬**: Claude Code가 불러올 수 있는 스킬과 커스텀 명령, 사용 횟수와 켜짐/꺼짐 상태
- **어디서든 열기**: 세션을 클릭하면, 그 폴더를 연 VS Code 창에서 Claude Code 세션을 이어서 엶

## 설치

마켓에 올리지 않은 확장이라, 저장소에서 `.vsix` 파일을 만들어 설치합니다. VS Code와 Antigravity 모두 같은 `.vsix`를 씁니다.

### 준비물

- Node.js와 npm: `.vsix`를 만들 때만 필요합니다. 만든 파일은 다른 PC로 옮겨 설치해도 됩니다.
- 설치할 에디터에 **Claude Code 확장**이 있어야 합니다. 없어도 Sessions/Conflicts/그래프/Skills 뷰는 동작하지만, 세션 열기, **Wrap Up Session**, 보관한 세션 숨기기는 이 확장을 씁니다.
- 허가 요청 표시를 쓰려면 Claude Code 2.1.295 이상이 필요합니다.

### 1. `.vsix` 만들기

저장소 폴더에서 실행합니다.

```sh
npm install
npm run package
```

`claude-code-multisession-0.0.1.vsix`가 생깁니다. `npm run package`는 `npx @vscode/vsce@4 package`를 다음 옵션과 함께 실행합니다. 컴파일은 패키징 과정에서 자동으로 됩니다(`vscode:prepublish`).

- `--allow-missing-repository`, `--skip-license`: `package.json`에 저장소 주소가 없고 LICENSE 파일이 없어서 vsce가 확인을 묻는 것을 건너뜁니다.
- `--no-rewrite-relative-links`: vsce는 README의 상대 링크(`src/parser.ts` 등)를 저장소 주소 기준의 절대 링크로 바꾸려 합니다. 저장소 주소가 없으면 오류를 내므로, 링크를 그대로 둡니다.

### 2-A. VS Code에 설치

- Extensions 뷰 → 오른쪽 위 `…` → **Install from VSIX…** → `.vsix` 선택
- 또는 터미널에서:

  ```sh
  code --install-extension claude-code-multisession-0.0.1.vsix
  ```

설치한 뒤 열려 있는 창마다 **Developer: Reload Window**를 실행합니다. 사용자 단위로 설치되므로 모든 창에서 동작합니다.

### 2-B. Antigravity에 설치

- Extensions 뷰 → 오른쪽 위 `…` → **Install from VSIX…** → `.vsix` 선택
- 또는 터미널에서(Antigravity IDE의 명령 이름은 `antigravity-ide`):

  ```sh
  antigravity-ide --install-extension claude-code-multisession-0.0.1.vsix
  ```

설치한 뒤 창을 다시 로드합니다. VS Code와 다른 점은 다음과 같습니다.

- Claude Code 확장도 Antigravity에 따로 설치되어 있어야 합니다.
- Antigravity IDE 1.1.x(VS Code 1.107 기반, Node 22)에서 확인했습니다. Node 22에서는 보관한 세션 목록을 처음 읽을 때 "SQLite is an experimental feature" 경고가 로그에 한 번 찍힐 수 있지만, 동작에는 문제가 없습니다.
- VS Code와 Antigravity를 **동시에** 쓰는 것은 고려하지 않았습니다. 두 앱은 확장 저장소가 달라서, 허가 요청 표시와 다른 창에서 열기가 앱 사이에서는 동작하지 않습니다.

### 3. 설치 후 설정 (한 번만)

명령 팔레트(`Ctrl+Shift+P`)에서 실행합니다.

1. **Claude Multi-Session: Install Permission Hooks**: 허가 요청 표시용 hook을 `~/.claude/settings.json`에 추가합니다. 확인 창에서 추가될 내용을 보여 주고, 기존 파일은 `settings.json.multisession-backup`으로 백업합니다. hook을 설치한 뒤에 새로 시작한 세션부터 적용됩니다.
2. **Claude Multi-Session: Install /wrap-up Skill Globally**: `/wrap-up` 스킬을 `~/.claude/skills/wrap-up/`에 설치합니다. 어느 폴더에서 시작한 세션이든 `/wrap-up`을 쓸 수 있게 됩니다.
3. 작업하는 저장소마다 `CLAUDE.md`에 대상 브랜치를 한 줄 적어 두면, `/wrap-up`이 매번 묻지 않습니다. 예: ``Feature branches merge into `product`.``

활동 표시줄의 **Claude Sessions** 아이콘을 열면 세션 목록이 보입니다. 필요하면 [설정](#설정)에서 `lookbackHours`(기본 24시간) 등을 조정합니다.

### 업데이트

1. 저장소를 최신으로 받고 1단계로 `.vsix`를 다시 만듭니다.
2. 2-A/2-B와 같은 방법으로 설치합니다(덮어써짐). 그리고 창을 다시 로드합니다.
3. `/wrap-up` 스킬이 바뀌었을 수 있으니 **Install /wrap-up Skill Globally**를 다시 실행합니다. 바뀐 게 없으면 "up to date"라고만 나옵니다.

### 제거

1. **Claude Multi-Session: Uninstall Permission Hooks**: `~/.claude/settings.json`에서 이 확장이 넣은 hook만 지웁니다. 확장을 먼저 지우면 hook이 남습니다. 남아도 요청이 바로 실패하고 Claude Code는 평소처럼 동작하지만, 깔끔하게 지우려면 이 명령을 먼저 실행하세요.
2. Extensions 뷰에서 **Claude Code Multi-Session Monitor**를 제거합니다.
3. `/wrap-up` 스킬도 지우려면 `~/.claude/skills/wrap-up/` 폴더를 지웁니다.

## 동작 방식

Claude Code는 세션마다 대화 기록을 `~/.claude/projects/<project>/<session-id>.jsonl`에 남깁니다. 확장은 이 파일들을 따라 읽으면서(`fs.watch`와 5초 간격 확인) 다음을 뽑아냅니다.

- 파일 접근: `Read` / `Edit` / `MultiEdit` / `Write` / `NotebookEdit` 도구 호출과 파일 경로
- 도구 호출과 그 결과, 사용자가 입력한 메시지: 허가 요청에 응답했는지 판단하는 데 씀
- 스킬 사용: `Skill` 도구 호출과 사용자가 입력한 슬래시 명령

세션의 **cwd**는 세션을 시작한 폴더, 즉 그 세션 대화 기록에 처음 나오는 `cwd`입니다. 세션이 도중에 `cd`로 다른 폴더로 옮기면 뒤쪽 줄에는 다른 cwd가 찍히지만 무시합니다. Git Bash 형식 경로(`/c/Users/...`)는 Windows 경로로 바꿉니다.

Claude Code 자체의 임시 폴더(`<tmp>/claude/…`, 세션별 `scratchpad/` 포함)에 있는 파일은 무시합니다. 머지되지 않는 일회용 스크립트와 출력물이라 그래프와 충돌 목록을 어지럽히기만 하기 때문입니다.

대화 기록 형식은 공식 API가 아닙니다. 형식에 관한 처리는 모두 [src/parser.ts](src/parser.ts)에 모아 두었습니다.

| 파일 | 역할 |
| --- | --- |
| [src/parser.ts](src/parser.ts) | JSONL 한 줄 → 이벤트(세션 정보, 제목(자동/바꾼 이름), 파일 접근, 도구 호출/결과, 사용자 메시지, 스킬 사용) |
| [src/transcriptWatcher.ts](src/transcriptWatcher.ts) | 대화 기록 파일을 이어서 읽기 |
| [src/sessionStore.ts](src/sessionStore.ts) | 세션 ↔ 파일 모델, 충돌 단계, 허가 요청 상태, 경로 정규화 |
| [src/viewModel.ts](src/viewModel.ts) | 범위/기간/워크스페이스 필터, 지식 파일 상태, 그래프 웹뷰용 데이터 |
| [src/treeViews.ts](src/treeViews.ts) | 사이드바: Sessions, Conflicts 뷰 |
| [src/graphPanel.ts](src/graphPanel.ts) + [media/graph.js](media/graph.js) | Cytoscape 그래프 웹뷰 |
| [src/claudeCode.ts](src/claudeCode.ts) | Claude Code 확장에서 세션 열기 |
| [src/claudeArchive.ts](src/claudeArchive.ts) | Claude Code에서 보관한 세션 목록 읽기 |
| [src/repoRoot.ts](src/repoRoot.ts) | 파일이 속한 git 저장소 루트와 worktree 관계, 현재 브랜치 찾기(캐시) |
| [src/permissions.ts](src/permissions.ts) | 허가 요청 hook: 로컬 수신기, 공용 이벤트 파일, hook 설치/제거 |
| [src/windowBridge.ts](src/windowBridge.ts) | 다른 VS Code 창에 세션 열기 요청 |
| [src/skills.ts](src/skills.ts) + [src/skillsTree.ts](src/skillsTree.ts) | 디스크의 스킬/커스텀 명령 찾기, 켜짐/꺼짐 상태, `/wrap-up` 설치. 사용 횟수가 붙은 Skills 뷰 |
| [.claude/skills/wrap-up/SKILL.md](.claude/skills/wrap-up/SKILL.md) | `/wrap-up` 스킬(확장에 함께 포함) |
| [CLAUDE.md](CLAUDE.md) | 이 저장소에서 작업하는 Claude Code 세션이 시작할 때 읽는 프로젝트 지식 |

## 기능

- **Sessions 뷰**: 세션을 워크스페이스(세션을 시작한 폴더)별로 묶고, 세션마다 건드린 파일을 보여 줍니다(✎ 수정, 👁 읽기). 이 창에 열린 폴더가 먼저 나옵니다. `claudeMultisession.groupByWorkspace`로 묶기를 끌 수 있습니다. 허가 요청을 기다리는 세션에는 🔔([허가 요청](#허가-요청)), 아직 지식을 정리하지 않은 세션에는 ⚑([프로젝트 지식 이어가기](#프로젝트-지식-이어가기))가 붙습니다.
  - 세션마다 체크박스가 있습니다. 체크를 풀면 목록에는 남지만 **그래프와 충돌 검사에서 빠집니다.** 남은 브랜치들을 머지할 때의 영향을 볼 때, 이미 끝난 작업을 빼는 용도입니다. 워크스페이스 그룹의 체크박스는 그 안의 세션 전체를 켜고 끕니다. 뺀 세션 목록은 재시작해도 유지됩니다.
- **보관한 세션 숨기기**: Claude Code에서 보관(Archive session)한 세션은 Sessions 뷰, 그래프, 충돌, 스킬 사용 횟수에서 모두 빠집니다. `claudeMultisession.showArchived`를 켜면 다시 보이고 `archived` 표시가 붙습니다. Claude Code가 이 상태를 공식 API로 내놓지 않아서 내부 저장소를 읽습니다([Claude Code 연동](#claude-code-연동) 참고).
- **Conflicts 뷰**: 포함된 세션 2개 이상이 건드린 파일. 활동 표시줄 아이콘에 개수 배지가 붙습니다. 세션들이 서로 다른 git worktree에서 작업했으면 툴팁에 세션마다 어느 브랜치(worktree)에서 건드렸는지 나오고, **Compare Across Worktrees**(인라인 버튼, 오른쪽 클릭)로 두 worktree의 파일을 diff 화면에서 비교할 수 있습니다. 비교 대상은 각 worktree에 지금 있는 파일이며, worktree가 셋 이상이면 비교할 둘을 고릅니다.
- **git worktree 지원**: 같은 저장소의 worktree들(`git worktree add`로 만든 폴더, Claude Code의 `.claude/worktrees/<이름>`)에 있는 같은 파일은 하나의 파일로 묶습니다. 그래서 브랜치마다 worktree를 따로 쓰는 세션끼리도 충돌이 잡힙니다. worktree의 `.git` 파일(`gitdir:`)과 그 안의 `commondir`을 읽어 원래 저장소를 찾으며, git 명령은 실행하지 않습니다. 서브모듈은 별도 저장소로 취급합니다. 세션 툴팁(트리, 그래프)에는 cwd에 지금 체크아웃된 브랜치가 나옵니다.
- **Skills 뷰**: 디스크에 있는 스킬과 커스텀 명령, 사용 횟수([스킬](#스킬) 참고)
- **그래프**: 왼쪽에서 오른쪽으로 그립니다. 세션은 왼쪽 열, 파일은 오른쪽 열에 놓이고, 각 세션의 파일은 그 세션 옆에 모입니다. 여러 세션이 함께 건드린 파일은 해당 세션 그룹들 사이에 놓입니다.
  - 세션 이름: 제목, 그 뒤에 cwd 폴더 이름. Claude Code에서 세션 이름을 바꿨으면 바꾼 이름(대화 기록의 `custom-title`)이, 아니면 Claude Code가 자동으로 붙인 제목(`ai-title`)이 나옵니다. Sessions 뷰도 같습니다.
  - 파일 이름: 그 파일이 속한 git 저장소 루트부터의 경로입니다(예: `my-repo/src/a.ts`). worktree 안의 파일도 원래 저장소 이름으로 나오므로, 어느 worktree, 어느 창에서 보든 같게 나옵니다. 저장소 밖의 파일은 세션 cwd부터의 경로로 나옵니다. 긴 경로는 왼쪽을 줄여 표시합니다. 트리에서도 파일 이름 옆에 같은 폴더 경로가 나옵니다. 저장소 루트는 캐시하므로, `git init` 뒤에는 **Rescan Transcripts**로 캐시를 비웁니다.
  - 빨간 파일: 세션 2개 이상이 수정
  - 주황 파일: 한 세션이 수정하고 다른 세션이 읽음
  - **Conflicts** 체크박스로 빨강/주황 강조를 끌 수 있음
  - 실선 화살표는 수정, 점선은 읽기
  - 마우스를 올리면 연결된 노드가 강조되고 툴팁이 나옴(세션은 전체 cwd, 파일은 전체 경로)
  - 필터: 워크스페이스 드롭다운(세션 cwd 기준), 충돌, 읽기 표시, 공유 파일만, 활성 세션만. 필터 선택은 패널을 다시 열어도 유지됩니다.
- **Claude Code에서 열기**: 트리나 그래프에서 세션을 클릭했을 때, 세션 cwd가 이 창의 워크스페이스 폴더와 정확히 같으면 Claude Code 확장에서 그 세션을 이어서 엽니다. 그 폴더를 연 다른 VS Code 창이 있으면 그 창에서 열고 그 창으로 전환합니다. 둘 다 아니면 대화 기록 파일을 엽니다. 세션을 오른쪽 클릭하면 **Open in Claude Code** / **Open Transcript** / **Wrap Up Session**이 있습니다.

### 프로젝트 지식 이어가기

브랜치마다 세션을 새로 열면, 새 세션은 이전 세션이 알게 된 것을 모른 채 시작합니다. 지식도 코드와 같은 길로 보내는 게 좋습니다.

- **브랜치에서 CLAUDE.md에 적습니다.** Claude Code는 세션을 시작할 때마다 `CLAUDE.md`를 읽습니다. 세션이 자기 브랜치에서 이 파일을 고쳐 커밋하면, 지식은 머지와 함께 대상 브랜치(`main`, `product` 등 그 브랜치가 합쳐지는 곳)에 들어가고 PR에서 함께 검토됩니다. 두 브랜치가 서로 다르게 적으면 git 충돌로 드러나고, 버린 브랜치의 내용은 남지 않습니다.
- **이 브랜치에만 해당하는 내용**(왜 바꿨는지, 남은 일)은 커밋 메시지와 PR 설명에 씁니다. 개인 취향은 저장소가 아니라 `~/.claude/CLAUDE.md`에 둡니다.
- git worktree를 쓰면, Claude Code의 자동 메모리(`~/.claude/projects/<경로>/memory/`)가 worktree 경로마다 따로 생깁니다. 저장소 안의 CLAUDE.md는 그렇지 않습니다.

확장이 돕는 부분:

- **⚑ not wrapped up**: 파일은 고쳤지만 지식 파일(`claudeMultisession.knowledgeFiles`, 기본값 `CLAUDE.md`)은 고치지 않은 세션에 Sessions 뷰에서 이 표시가 붙습니다. 지식 파일은 📘 책 아이콘으로 나옵니다. Claude의 도구로 고친 것만 셉니다.
- **Wrap Up Session**(세션 오른쪽 클릭): 이 창이나 그 폴더를 연 창에서 세션을 이어서 열고, 입력창에 `claudeMultisession.wrapUpPrompt`(기본값 `/wrap-up`)를 넣어 둡니다. Claude Code 2.1.x는 이 문장을 보내지 않고 입력창에만 넣습니다. 그 폴더를 연 창이 없으면 문장을 클립보드에 복사합니다.
- **Conflicts**: 여러 세션이 고친 지식 파일에는 `📘 knowledge`가 붙습니다. 그 세션들이 적은 내용이 브랜치를 머지할 때 충돌할 수 있다는 뜻입니다.

[/wrap-up 스킬](.claude/skills/wrap-up/SKILL.md)은 이 저장소에서 관리하고 확장에 함께 들어 있습니다. 먼저 이 브랜치가 합쳐질 대상 브랜치를 정합니다. `main`으로 가정하지 않고, 사용자가 말한 브랜치, CLAUDE.md에 적힌 브랜치, git 기록으로 추정한 브랜치(사용자에게 확인) 순서로 정합니다. 그다음 세션에서 알게 된 것을 CLAUDE.md에 넣을 것, 이 브랜치에만 해당하는 메모, 개인 취향으로 나눈 뒤 CLAUDE.md를 고치고, 커밋하기 전에 묻습니다. `disable-model-invocation`이 켜져 있어서 사용자가 직접 입력할 때만 실행됩니다.

**Claude Multi-Session: Install /wrap-up Skill Globally**를 실행하면 `~/.claude/skills/wrap-up/`에 복사되어, 어느 폴더에서 시작한 세션이든 쓸 수 있습니다. 저장소의 스킬을 고친 뒤에는 다시 실행하세요. 바뀐 게 없으면 "up to date"라고 알리고, 전역 사본을 직접 고쳐 둔 경우에는 덮어쓰기 전에 묻습니다. 스킬이 설치되어 있지 않으면 **Wrap Up Session**이 설치를 권합니다.

저장소의 사본만으로는 이 저장소(또는 그 하위 폴더)에서 시작한 세션에서만 읽힙니다. Claude Code는 시작 폴더와 그 상위 폴더의 `.claude/skills`를 읽습니다. 하위 폴더의 스킬은 Claude가 그 폴더의 파일을 건드리거나 `/add-dir`을 실행한 뒤에야 읽힙니다.

### 스킬

**Skills** 뷰는 Claude Code가 불러올 수 있는 스킬과 커스텀 슬래시 명령을 있는 위치별로 묶어 보여 줍니다.

| 그룹 | 위치 | 편집 |
| --- | --- | --- |
| Project · *폴더* | `<워크스페이스 폴더>/.claude/skills/<이름>/SKILL.md`, `.claude/commands/**.md` | 가능 |
| Personal | `~/.claude/skills/<이름>/SKILL.md` | 가능 |
| Custom commands | `~/.claude/commands/**.md`(예전 단일 파일 형식, 하위 폴더는 `sub/name`이 됨) | 가능 |
| Plugins | `~/.claude/plugins` 아래 설치된 플러그인 안의 `skills/<이름>/SKILL.md` | 🔒 플러그인 업데이트 때 덮어써짐 |
| claude.ai (synced) | `~/.claude/skills/synced/…`: claude.ai 계정에서 동기화된 스킬 | 🔒 동기화 때 덮어써짐 |

- 항목마다 frontmatter의 `description`이 나옵니다. 클릭하면 파일이 열리고, 오른쪽 클릭하면 **Reveal in File Explorer**가 있습니다.
- **사용 횟수**: `3×`는 **이 워크스페이스의 세션**(cwd가 열린 폴더이거나 그 하위)이 `lookbackHours` 기간 안에 3번 썼다는 뜻입니다. Claude가 `Skill` 도구로 호출한 것과 사용자가 `/이름`으로 입력한 것을 모두 셉니다. 툴팁에는 쓴 세션 목록과 전체 워크스페이스 합계가 나옵니다. 플러그인과 synced 스킬은 `anthropic-skills:docx`처럼 앞에 묶음 이름이 붙은 호출도 `docx`로 셉니다.
- **Used, not on disk**: 이 워크스페이스의 세션에서 Claude가 호출했지만 디스크에 `SKILL.md`가 없는 스킬입니다. Claude Code에 내장된 스킬 등이 여기에 해당합니다. 다른 워크스페이스의 세션은 셈하지 않습니다. 그쪽의 프로젝트 스킬은 여기 목록에 없기 때문입니다.
- **켜짐/꺼짐 상태**: Claude Code와 같은 설정을 읽어, 열린 폴더마다 합쳐서 판단합니다. 사용자 `~/.claude/settings.json` < 프로젝트 `.claude/settings.json` < 로컬 `.claude/settings.local.json` 순서로, 키 단위로 덮어씁니다. 조직(관리자) 설정은 읽지 않습니다.
  - `[off]`(흐린 아이콘): `skillOverrides`에서 `"off"`로 둔 스킬, 또는 `enabledPlugins`에서 `false`로 둔 플러그인입니다. 플러그인 키는 `<plugin>@<marketplace>`이고, `cache/<marketplace>/<plugin>/<version>/` 폴더에서 알아냅니다. 플러그인 설명 파일에 `defaultEnabled: false`가 있으면, `enabledPlugins`로 켜지 않는 한 꺼진 것으로 봅니다.
  - `[off in some folders]`: 여러 폴더를 열었을 때 일부 폴더의 세션에서만 꺼진 경우입니다. 툴팁에 해당 폴더가 나옵니다.
  - `[name-only]` / `[user-invocable-only]`: `skillOverrides`의 다른 모드입니다.
  - 프로젝트 스킬은 자기 폴더의 설정으로만 판단합니다.
- **New Skill**(뷰 제목의 ＋): 위치(프로젝트 폴더 또는 Personal), 이름(소문자, 숫자, 하이픈), 설명을 차례로 묻고, 틀에서 `<이름>/SKILL.md`를 만들어 엽니다.
- 위 폴더의 파일이 바뀌면 다시 읽습니다. **Rescan Skills**로 직접 다시 읽을 수도 있습니다.

이 뷰는 상태를 보여 주기만 합니다. 바꾸려면 설정 파일을 고치거나, 플러그인은 `/plugin`을 쓰세요. 바뀐 내용은 뷰에 자동으로 반영됩니다.

### 허가 요청

도구 실행 승인을 기다리는 세션을 보여 줍니다. 공식 인터페이스인 [Claude Code hooks](https://code.claude.com/docs/en/hooks)를 쓰므로, 먼저 **Claude Multi-Session: Install Permission Hooks**를 한 번 실행합니다. 확인을 누르면 `~/.claude/settings.json`에 `http` hook을 추가하고, 기존 파일은 `settings.json.multisession-backup`으로 백업합니다.

- `PermissionRequest`(모든 도구): Claude가 허가를 물으려는 순간 실행됩니다.
- `Notification`(matcher `permission_prompt`): 허가 요청에 약 6초간 응답이 없을 때 실행되는 보조 신호입니다.

둘 다 `http://127.0.0.1:<claudeMultisession.hookPort>/claude-multisession/hook`으로 POST를 보내며, timeout은 2초이고 `onFailure: "continue"`입니다. 확장은 결정 없이 바로 `{}`로 응답하므로, Claude Code는 항상 평소처럼 허가 창을 띄웁니다. 받아 줄 VS Code 창이 없으면 요청이 바로 실패하고 허가 창도 평소처럼 뜹니다. **Uninstall Permission Hooks**는 이 확장이 넣은 항목만 지웁니다.

기다리는 세션은 Sessions 뷰에서 🔔 아이콘과 요청 요약(예: `Bash: npm test`)으로 표시되고, 대기 수 배지가 붙습니다. 그래프에서는 노란 테두리가 깜빡이고, **Open Session** 버튼이 있는 알림도 뜹니다(`claudeMultisession.notifyPermission`으로 끌 수 있음). 대화 기록에 그 도구의 결과(승인 후 실행, 실패, 거부)가 나오거나 사용자가 새 메시지를 보내면 응답한 것으로 봅니다. 응답 없는 요청은 2시간이 지나면 사라집니다.

포트는 VS Code 창 하나만 열 수 있습니다. 그 창이 받은 이벤트를 확장의 전역 저장소에 있는 파일에 기록하고, 모든 창이 그 파일을 읽습니다. 포트를 연 창이 닫히면 다른 창이 15초 안에 이어받습니다.

한계: `PermissionRequest`에는 도구 호출 ID가 없어서, 같은 도구의 다음 결과와 짝을 짓습니다. `onFailure`는 Claude Code 2.1.295 이상이 필요합니다. VS Code 확장은 2.1.233부터 `permission_prompt` 알림을 보냅니다.

### Claude Code 연동

세션 열기는 Claude Code 확장의 내부 명령 `claude-vscode.editor.open`을 쓰고, 실패하면 `vscode://anthropic.claude-code/open?session=<id>` URI로 시도합니다. 둘 다 공식 API가 아니어서(Claude Code 2.1.x에서 찾아냄) Claude Code가 업데이트되면 깨질 수 있습니다. 모든 시도는 **Claude Multi-Session** 출력 채널에 기록됩니다.

Claude Code는 세션을 시작한 폴더 기준으로 관리하므로, cwd가 워크스페이스 폴더와 *정확히 같은* 세션만 이 창에서 이어서 열 수 있습니다. 하위 폴더에서 시작한 세션은 그 하위 폴더를 연 창이 필요합니다.

보관한 세션 목록은 Claude Code 확장이 VS Code 확장 저장소(`globalState`)의 `hiddenSessionIds`에 저장합니다. 실제 위치는 `<사용자 폴더>/globalStorage/state.vscdb`(SQLite)의 `ItemTable` 테이블, `Anthropic.claude-code` 행입니다. 확장은 VS Code에 내장된 `node:sqlite`로 이 값을 10초마다 읽기만 합니다. VS Code가 이 파일을 조금 늦게 쓰므로, 보관한 뒤 수십 초 안에 반영됩니다. Claude Code가 세션 폴더에 `archived.json`을 남기는 경우도 함께 읽습니다. 읽지 못하면 출력 채널에 `[archive]` 줄을 한 번 남기고, 보관한 세션도 그대로 보여 줍니다. 공식 API가 아니므로 Claude Code 업데이트로 깨질 수 있습니다.

확장 API로는 다른 창을 보거나 메시지를 보낼 수 없어서, 창끼리 확장의 전역 저장소 폴더를 통해 주고받습니다. 각 창은 10초마다 자기 워크스페이스 폴더를 `windows/<id>.json`에 기록합니다. 세션을 넘길 때는 대상 창이 주기적으로 확인하는 `requests/<target-id>/`에 요청을 쓰고, 세션 cwd에 대해 `vscode.openFolder`를 새 창 모드로 실행합니다. 그 폴더가 이미 열려 있으므로 VS Code는 새 창 대신 기존 창으로 전환합니다. 같은 폴더를 연 창이 여럿이면 가장 최근에 포커스된 창이 받습니다. 15초가 지난 요청은 버리고, 기록이 35초 넘게 갱신되지 않은 창(비정상 종료 등)은 무시합니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `claudeMultisession.projectsDir` | `~/.claude/projects` | 대화 기록 폴더 |
| `claudeMultisession.lookbackHours` | `24` | 이보다 오래된 세션은 무시 |
| `claudeMultisession.activeMinutes` | `10` | 이 시간 안에 활동이 있으면 "active" |
| `claudeMultisession.groupByWorkspace` | `true` | Sessions 뷰를 워크스페이스(세션 cwd)별로 묶기 |
| `claudeMultisession.hookPort` | `47821` | 허가 요청 hook용 로컬 포트(바꾼 뒤에는 **Install Permission Hooks**를 다시 실행) |
| `claudeMultisession.notifyPermission` | `true` | 세션이 허가 요청을 기다리기 시작하면 알림 |
| `claudeMultisession.knowledgeFiles` | `["CLAUDE.md"]` | 세션이 알게 된 것을 적는 파일(파일 이름 또는 경로 끝부분). 파일은 고쳤지만 이 파일들은 고치지 않은 세션은 "not wrapped up"으로 표시 |
| `claudeMultisession.wrapUpPrompt` | `/wrap-up` | **Wrap Up Session**이 Claude Code 입력창에 넣는 문장 |
| `claudeMultisession.showArchived` | `false` | Claude Code에서 보관한 세션도 표시 |
| `claudeMultisession.scope` | `all` | `workspace`로 두면 트리와 그래프에 cwd가 열린 폴더(또는 그 하위)인 세션만 표시 |

## 개발

```sh
npm install
npm run compile
```

VS Code에서 **F5**를 눌러 Extension Development Host를 띄운 뒤, 활동 표시줄의 **Claude Sessions** 아이콘을 열거나 `Claude Multi-Session: Open Session Graph`를 실행합니다.

- `media/` 아래를 고쳤으면 그래프 패널만 다시 열면 됩니다. `src/`나 `package.json`을 고쳤으면 디버그 세션을 재시작해야 합니다.
- **Open in Claude Code**를 시험하려면, 세션을 시작한 폴더를 Development Host 창에서 엽니다. 세션은 그 cwd를 연 창에서만 "현재 워크스페이스"로 취급됩니다.
- 여러 창이 필요한 기능(다른 창에서 세션 열기, 허가 요청 포트 공유)은 각 창에서 확장이 돌아야 합니다. Development Host에서 **New Window**로 연 창은 확장이 없는 일반 창입니다. 대신 저장소를 일반 확장 폴더에 연결하고(`mklink /J "%USERPROFILE%\.vscode\extensions\local.claude-code-multisession-0.0.1" <저장소 경로>`) 일반 창들을 다시 로드한 뒤, 그 창들끼리 시험합니다. 끝나면 `rmdir`로 연결을 지웁니다(연결만 지워짐).
- [.claude/skills/wrap-up/SKILL.md](.claude/skills/wrap-up/SKILL.md)를 고친 뒤에는 **Install /wrap-up Skill Globally**를 실행해 `~/.claude/skills/wrap-up/`을 갱신합니다.
- [CLAUDE.md](CLAUDE.md)에는 Claude Code 세션이 이 저장소에 대해 알아야 할 것을 적습니다. 브랜치 작업을 마칠 때 `/wrap-up`으로 갱신합니다.

## 문제 해결

- **Claude Sessions 아이콘이 없고 뷰가 탐색기 아래에 나옴.** 일부 Claude Code 버전은 proposed API `contribSecondarySidebar`를 씁니다. 이를 허용하지 않는 VS Code 빌드에서는 뷰 컨테이너를 등록하다 오류가 나고, 모든 확장의 활동 표시줄 컨테이너가 탐색기로 밀려납니다(로그에 `View container '…' does not exist`가 찍힘). VS Code를 업데이트하거나, `argv.json`(**Preferences: Configure Runtime Arguments**)에 `"enable-proposed-api": ["Anthropic.claude-code"]`를 추가하세요. 동봉된 [.vscode/launch.json](.vscode/launch.json)은 Development Host에 이미 `--enable-proposed-api Anthropic.claude-code`를 넘깁니다.
- **세션을 클릭해도 아무 일이 없음.** **Claude Multi-Session** 출력 채널을 확인하세요. 클릭할 때마다 `[click] … resumable=…` 줄(세션 cwd와 비교한 워크스페이스 폴더 포함)이 찍히고, 이어서 `[open]` 줄이 찍힙니다. 다른 창으로 넘길 때는 양쪽 창에 `[bridge]` 줄이 찍힙니다.
- **허가 요청에 🔔가 안 뜸.** 출력 채널에 hook이 설치되지 않았다고 나오면 **Install Permission Hooks**를 실행하세요. 이미 실행 중이던 세션은 새 hook을 못 읽을 수 있으니 새 세션으로 시도해 보세요. 허가 요청이 들어오면 출력 채널에 `[hook]` 줄이 찍힙니다.
- **세션에서 `/wrap-up`(또는 다른 프로젝트 스킬)이 안 보임.** Claude Code는 세션을 시작한 폴더와 그 상위 폴더에서만 프로젝트 스킬을 읽고, 하위 폴더에서는 읽지 않습니다. 이 저장소의 상위 폴더에서 시작한 세션은, Claude가 저장소 안의 파일을 건드리거나 `/add-dir`을 실행하기 전까지 저장소의 스킬을 못 봅니다. `/wrap-up`은 **Install /wrap-up Skill Globally**를 실행하면 해결됩니다. 그래도 안 보이면 `/reload-skills`를 실행하세요.

- **`.vsix` 설치 중 `Please restart VS Code before reinstalling Claude Code Multi-Session Monitor`가 재시작 후에도 계속 남.** 예전에 설치했던 흔적(예: 개발 중 만든 junction을 지운 경우)이 `~/.vscode/extensions/extensions.json`에 남아, 폴더가 없는데도 설치된 것으로 기록된 경우입니다. 이 파일을 백업한 뒤 `"id":"local.claude-code-multisession"` 항목만 지우고 다시 설치하세요. Antigravity는 `~/.antigravity-ide/extensions/extensions.json`입니다.
- **`antigravity-ide --install-extension`이 `Error loading V8 startup snapshot file`로 실패함.** Antigravity 업데이트가 중간에 멈춰 설치 폴더에 실행 파일만 남은 상태입니다(`snapshot_blob.bin`, `resources` 등이 업데이트 작업 폴더 `_`에 남아 있음). Antigravity 창을 모두 닫고 설치 파일로 다시 설치한 뒤 시도하세요.

## 로드맵

- 기존 hook 수신기에 hook 더 붙이기(`PreToolUse` / `PostToolUse`): 공식 인터페이스로 실시간 파일 이벤트를 받고, 다른 세션이 같은 파일을 고치고 있으면 경고
- Skills 뷰에서 스킬 켜고 끄기(`skillOverrides` / `enabledPlugins`에 기록)
- 워크스페이스 폴더 하위 폴더에 있는 프로젝트 스킬도 표시(Claude가 그 폴더를 건드리면 로드됨)
- 대상 브랜치 기준 diff: 지금은 worktree에 있는 파일끼리 비교하므로, 커밋 기준(대상 브랜치와의 차이) 비교는 git 명령이 필요함
- `Edit.old_string`으로 줄 범위가 겹치는지 감지
- 타임라인 뷰
