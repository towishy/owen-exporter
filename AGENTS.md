# Owen Exporter Agent Instructions

이 저장소는 Owen Exporter 프로젝트다. Obsidian/문서 산출물 export 흐름과 연결되는 도구로 취급한다.

## Knowledge Source

VS Code에서는 이 프로젝트와 `C:\OWEN\github\wiki`를 멀티 루트 워크스페이스로 함께 연다.

- `C:\OWEN\github\wiki`를 디자인·지식 참고 루트로 상시 취급한다.
- UI/UX, 접근성, 반응형 또는 컴포넌트 작업 전 `lib/ui-foundation/`, `lib/ui-lab/src/`, 관련 `lib/ui-foundation/REFERENCE-STUDY-*.md`를 작업 용어로 검색하고 해당 소스를 확인한다.
- 사용자가 명시적으로 요청하지 않으면 `C:\OWEN\github\wiki`의 파일은 읽기 전용으로 유지한다.
- `C:\OWEN\github\wiki`에 접근할 수 없으면 추측으로 대체하지 않고, 검증하지 못한 사실을 완료 보고에 명시한다.

문서 export, Obsidian, Owen Graphite, PDF/HTML 산출물 관련 작업은 wiki를 먼저 참조한다.

```powershell
Push-Location C:\OWEN\github\wiki
.\.venv\Scripts\python.exe scripts\wiki-query.py "exporter PDF HTML Obsidian" --limit 7 --json
Pop-Location
```

<!-- ui-portal-usage:start -->
## Owen UI Portal 사용

- UI/UX, frontend, component, 접근성, 반응형 또는 시각 자산 작업을 계획하거나 편집하기 전 companion WIKI의 UI Portal을 task-specific 자산 선택의 기본 라우터로 사용한다.
- WIKI 루트는 멀티루트 workspace의 `wiki`, sibling `../wiki`, 현재 플랫폼의 알려진 WIKI 경로 순서로 찾으며 하나의 절대 경로만 가정하지 않는다.
- 구현용 선택은 WIKI 루트에서 `node scripts/ui-portal/query-assets.mjs brief "<한 문장의 output job>" --limit 5`를 실행하고 Task Profile, Context Pack, exact Asset ID, `ownerPath`/`ownerApi`, maturity와 validation을 확인한다. broad Registry를 모델 컨텍스트에 넣거나 Asset ID를 추측하지 않는다.
- 시각 검토는 WIKI의 `process: UI Portal Controller`를 실행·재사용하고 VS Code 내장 브라우저에서 `/uiportal query="<작업>"` 또는 `http://127.0.0.1:4172/portal/`을 연다.
- Portal은 라우팅·증거 surface이고 Foundation의 `DESIGN.md`와 owning source가 최종 계약이다. WIKI는 명시적 요청이 없으면 읽기 전용으로 유지하며, 접근할 수 없으면 미검증 범위를 보고한다.
<!-- ui-portal-usage:end -->

## UI Direction

UI 작업 전 sibling workspace folder `wiki`의 `wiki/concepts/ui-design-system-knowledge.md`를 우선 참조한다.
디자인/프론트엔드 작업을 시작하기 전 `C:\OWEN\github\wiki\lib\ui-foundation`의 `README.md`, `DESIGN.md`, `tokens/`, `src/` 컴포넌트 계약을 읽고 현재 프로젝트에 맞게 적용한다.

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

## Localization Contract

- 사용자 노출 UI의 기본 언어는 영어(`en`)다.
- 기능을 추가하거나 변경할 때 영어와 한국어(`ko`) 문자열을 같은 변경에서 함께 구현한다. 설정, 명령, 메뉴, 버튼, tooltip, aria-label, modal, notice, 진행 상태·오류 문구를 빠뜨리지 않는다.
- 사용자 노출 문자열을 기능 코드에 직접 하드코딩하지 않고 typed i18n catalog와 번역 함수를 사용한다.
- 내부 ID, export machine enum, 파일 경로, 사용자 데이터, 원시 오류 detail은 번역하지 않는다.
- 기본 preference는 `auto`다. Obsidian locale이 `ko` 계열이면 한국어, 그 외에는 영어를 사용하며, 사용자가 고른 `en`/`ko` override가 자동값보다 우선한다.
- 영어/한국어 key parity, 영어 fallback, 보간, 자동 locale 해석, override 우선순위를 자동 검사에 포함하고 릴리스 전에 통과시킨다.

<!-- ui-foundation-design-guide:start -->
## 공통 UI 디자인·AI 구현 가이드

- UI·UX·frontend·접근성·반응형 작업 전에 [공통 가이드 안내](docs/wiki-design/README.md)와 [개발 가이드](UI-FOUNDATION-DESIGN-GUIDE.md)를 읽는다. 필요한 owner와 reference만 선택하며 문서 전체를 일괄 로드하지 않는다.
- 시각·동작 기준은 [공통 DESIGN](docs/wiki-design/lib/ui-foundation/DESIGN.md), 구현 API·maturity·선택 절차는 [AI-USAGE](docs/wiki-design/lib/ui-foundation/AI-USAGE.md)가 소유한다.
- 이 경로는 과거 WIKI 절대경로, 이전 Lab 개수, 프로젝트 DESIGN.md에 내장된 과거 공통 스냅샷보다 우선한다. 프로젝트 고유 output job·제품 결정과 더 엄격한 보안·접근성·runtime 제약은 보존한다.
- 공통 복사본은 WIKI에서 단방향 동기화한다. 공통 기준 변경은 원본 WIKI에서 하고 로컬 복사본은 직접 수정하지 않는다. UI가 없는 프로젝트에 새 화면을 만들라는 지시가 아니다.
<!-- ui-foundation-design-guide:end -->
