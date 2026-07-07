# Owen Exporter Agent Instructions

이 저장소는 Owen Exporter 프로젝트다. Obsidian/문서 산출물 export 흐름과 연결되는 도구로 취급한다.

## Knowledge Source

VS Code에서는 이 프로젝트와 `C:\OWEN\github\wiki`를 멀티 루트 워크스페이스로 함께 연다.

문서 export, Obsidian, Owen Graphite, PDF/HTML 산출물 관련 작업은 wiki를 먼저 참조한다.

```powershell
Push-Location C:\OWEN\github\wiki
.\.venv\Scripts\python.exe scripts\wiki-query.py "exporter PDF HTML Obsidian" --limit 7 --json
Pop-Location
```

## UI Direction

UI 작업 전 sibling workspace folder `wiki`의 `wiki/concepts/ui-design-system-knowledge.md`를 우선 참조한다.

기본 조합:

- Extend-UI / shadcn component structure
- Owen Graphite Liquid Glass visual surface
- Reicon for richer icon options
- Border Beam only for focused emphasis
- Boneyard only for data-heavy app skeleton loading

## Project Commands

```powershell
npm run dev
npm run test
npm run build
npm run release
```

## Local Rules

- export 결과물은 글꼴, 표, callout, 코드블록, 이미지 overflow를 우선 확인한다.
- PDF/HTML 출력 변경은 샘플 문서로 실제 렌더를 확인한다.
- 빌드 전 `npm run test`를 유지한다.
