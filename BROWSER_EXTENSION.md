# Browser Extension — 설치 및 사용 가이드

Agent Salad의 `web_browse` 스킬은 유저의 실제 Chrome 브라우저를 Extension으로 제어합니다.  
Playwright 대신 Chrome Extension을 사용하여 봇 감지에 걸리지 않고 웹사이트를 탐색할 수 있습니다.

## 아키텍처

```
LLM → browse_* tool → WebSocket Server (:3210/ws/browser)
                              ↕ WebSocket
                       Chrome Extension (background.js)
                              ↕ chrome.runtime.sendMessage
                       Content Script (content.js) ← 페이지 DOM 직접 접근
```

- **state-first, index-based**: LLM이 `browse_state`로 인터랙티브 요소를 인덱스 맵으로 받고, 인덱스 번호로 클릭/타이핑
- **browser-use 로직 포팅**: `content.js`의 DOM 파싱/직렬화는 [browser-use](https://github.com/browser-use/browser-use)의 `ClickableElementDetector` + `DOMTreeSerializer`를 JS로 1:1 포팅

## Extension 설치

### 소스 폴더 로드

저장소를 clone한 뒤 `extension/` 폴더를 Chrome에 직접 로드합니다.

Web UI의 Skills 탭 하단 버튼도 `extension/` 소스 폴더 위치를 안내합니다.

### Chrome에 로드

1. Chrome에서 `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 저장소의 `extension/` 폴더 선택

## 서버 연결

1. Extension 아이콘(주소창 오른쪽) 클릭
2. 서버 주소 확인 (기본: `127.0.0.1:3210`)
3. **연결** 버튼 클릭
4. "연결됨" 상태 확인

## 도구 목록 (12개)

| 도구 | 설명 | 핵심 인자 |
|------|------|-----------|
| `browse_state` | 현재 탭의 인터랙티브 요소 인덱스 맵 | `viewportOnly?` |
| `browse_navigate` | URL로 이동 | `url` |
| `browse_click` | 인덱스로 클릭 | `index` |
| `browse_type` | 인덱스 요소에 텍스트 입력 | `index`, `text` |
| `browse_keys` | 키보드 입력 | `keys` (e.g. "Enter") |
| `browse_select` | 드롭다운 선택 | `index`, `value` |
| `browse_screenshot` | 현재 화면 캡처 | `filename?` |
| `browse_scroll` | 스크롤 | `direction`, `pixels?` |
| `browse_eval` | JavaScript 실행 | `code` |
| `browse_tabs` | 열린 탭 목록 | — |
| `browse_tab_switch` | 탭 전환 | `tabIndex` |
| `browse_wait` | 요소/텍스트 대기 | `selector?`, `text?`, `timeout?` |

## browse_state 출력 예시

```
viewport: 1280x720
page: 1280x3200
scroll: (0, 0)
url: https://example.com
title: Example Domain

[0]<a href="https://www.iana.org/domains/example" /> More information...
[1]<input type="text" name="q" placeholder="검색..." />
[2]<button type="submit" /> 검색
```

## LLM 워크플로우

1. `browse_state` 호출 → 인덱스 맵 확인
2. 인덱스로 `browse_click(1)` / `browse_type(1, "검색어")` 등 상호작용
3. `browse_state` 재호출 → 결과 확인
4. 반복

## 보안

- Extension은 기본적으로 `127.0.0.1`에만 연결
- 외부 접근 시 토큰 인증 추가 필요 (추후)
- Extension Permission: `activeTab`, `tabs`, `scripting`, `storage`, `alarms`, `debugger`
- `debugger` 권한은 CDP를 통한 isTrusted 입력 이벤트 생성에 사용 (browser-use 방식)

## 트러블슈팅

- **"Browser extension not connected"**: Extension이 서버에 연결되지 않았습니다. Extension 팝업에서 연결 상태를 확인하세요.
- **"Element index N is stale"**: DOM이 변경되어 인덱스가 무효화되었습니다. `browse_state`를 다시 호출하세요.
- **Content Script가 동작하지 않는 페이지**: `chrome://` 같은 브라우저 내부 페이지에는 Extension이 접근할 수 없습니다.
