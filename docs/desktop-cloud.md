# Claude Desktop의 로컬 MCP로 클라우드 저장소 사용하기

2026-10-29 기준 전용 데스크톱 확장은 로컬 stdio 프로그램을 실행하고 OAK의 HTTPS MCP 서버에 개인 저장소 키로 연결한다. 기억은 OAK 클라우드에 남는다. 로컬 데이터베이스, Docker, Ollama와 별도 Node 설치는 필요하지 않다. 원격 OAuth 플러그인 `oak-memory-cloud`, 기존 로컬 플러그인 `oak-memory`와 구분하기 위해 이름은 `oak-desktop-cloud`다.

## 설치와 설정

[Desktop Cloud 릴리스](https://github.com/fredriccliver/oak-memory-plugin/releases)에서 `oak-desktop-cloud-0.2.0.mcpb`를 내려받는다. Claude Desktop의 Settings, Extensions, Advanced settings, Install Extension에서 파일을 선택한다. 메뉴 이름은 앱 버전에 따라 달라질 수 있다.

OAK 대시보드에서 연결할 저장소를 선택한다. 저장소의 연결 설정에서 ID를 복사하고 본인 계정의 이름 있는 연결 키를 만든다. 키는 생성할 때 한 번 표시되므로 확장 설정의 Personal key에 직접 입력한다. 채팅이나 저장소 파일에 키를 붙이지 않는다. Store ID에는 같은 저장소의 UUID를 입력한다. Claude는 민감한 설정을 운영체제의 보안 저장소에 보관한다.

Allow memory changes는 기본으로 꺼져 있다. 켠 경우에만 저장, 수정, 삭제와 정책 변경을 전달한다. 서버의 저장소 역할과 크레딧 검사, Claude의 도구 승인은 계속 적용된다. 도구 목록 조회 중 역할 확인이 실패하면 변경 도구를 숨긴다. 변경 호출은 그 시점에 역할을 다시 확인하므로, 일시적인 조회 장애가 회복되면 새 권한 확인을 통과한 호출은 허용된다. 이전 조회 실패를 세션 전체에 고정하지 않는다. 이 옵션은 기억의 자동 저장을 켜지 않는다. OAuth 동의와 달리 개인 키 자체에는 읽기 전용 범위를 부여하지 않으므로, 읽기 제한은 이 확장의 실행 경계에서 적용한다. 서버에서도 쓰기를 제한하려면 reader 역할의 저장소를 사용한다.

새 대화에서는 다른 OAK 연결을 끄고 이 확장만 켠다. `memoryConnectionStatus`로 backend가 cloud이며 의도한 저장소와 역할인지 확인하고 `listMemories`를 실행한다. 인증 실패, 철회와 연결 실패 시 로컬 저장소나 다른 저장소로 전환하지 않는다. 단일 저장소를 바꾸려면 설정의 ID와 해당 저장소의 별도 개인 키를 함께 바꾸고 연결을 다시 시작한다. 연결을 철회하려면 OAK에서 키를 폐기한다.

## 여러 저장소 연결

0.2.0부터 확장 설정의 Stores (JSON)에 저장소 목록을 입력할 수 있다. 이 필드는 개인 키를 포함하므로 민감한 설정으로 선언되어 있다. 다음 예시의 UUID와 키 자리를 각 저장소의 실제 값으로 바꾸되, 실제 키는 채팅이나 파일에 저장하지 않고 확장 설정에만 입력한다.

```json
[
  {"name":"Personal","storeId":"PERSONAL_STORE_UUID","personalKey":"PERSONAL_STORE_KEY"},
  {"name":"Team","storeId":"TEAM_STORE_UUID","personalKey":"TEAM_STORE_KEY"}
]
```

기존 Store ID와 Personal key 한 쌍도 계속 동작한다. 이 설정을 유지한 채 Stores에 다른 저장소를 추가해도 된다. 기존 쌍을 지우고 목록만 사용해도 된다. 저장소 ID와 프로필 이름은 중복되면 안 된다. 목록은 최대 20개 항목이며, 잘못된 항목이나 불완전한 기존 쌍이 있으면 시작을 중단한다. 잘못된 목록을 무시하고 단일 저장소로 연결하지 않는다.

여러 저장소가 설정되면 `listMemoryStores`는 설정된 저장소마다 해당 키로 신원과 역할을 확인한다. 키가 없는 다른 저장소를 자동으로 추가하지 않는다. `recallMemory`와 `listMemories`는 `storeId`를 생략하면 설정된 저장소 전체를 병렬 조회하며 결과를 저장소 ID와 프로필별로 묶는다. 지정하면 그 저장소만 조회한다. 각 저장소의 결과 순위와 제한은 개별 서버에서 적용되며 전체 저장소에 대한 통합 순위는 만들지 않는다. 일부 인증이나 연결이 실패하면 해당 항목에 오류를 남기고 `partialFailure: true`로 표시한다. 다른 저장소의 성공을 전체 성공으로 해석하지 않는다.

저장·수정·삭제 등 변경 도구와 나머지 원격 도구는 명시적인 `storeId`가 필요하다. 없는 ID, 빈 ID 또는 설정되지 않은 ID는 다른 저장소로 대체하지 않는다. 변경 직전에 선택한 저장소의 신원과 역할을 다시 확인한다. Allow memory changes가 꺼져 있거나 reader 역할이면 변경을 전달하지 않는다. `selectMemoryProfile`은 현재 대화의 상태 확인과 단일 저장소 조회 기본값만 바꾸며, 전체 검색 범위와 변경 대상은 바꾸지 않는다. 진행 중인 호출도 다른 저장소 키로 전환되지 않는다.

## 개인 계정과 회사 계정

개인 계정은 원격 OAuth 연결 또는 이 확장을 선택할 수 있다. 회사 계정은 조직이 허용한 로컬 확장만 설치한다. 원격 커넥터를 조직에 추가하는 권한과 로컬 확장을 허용하는 권한은 별개다. GitHub 마켓플레이스 설치나 이 파일 다운로드가 조직 정책을 해제하지 않는다. 로컬 확장이 차단되면 조직 소유자가 허용해야 한다. 이미 허용된 확장이 있으면 새 설치보다 현재 설정과 실제 호출을 먼저 확인한다.

이 방식은 Claude Desktop용이다. 웹 Claude나 ChatGPT에 로컬 MCPB를 설치하는 안내로 사용하지 않는다. 로컬 DB를 사용하는 기존 플러그인과 클라우드 확장을 자동 동기화하지 않는다.

## 개발과 검증

`npm run package:desktop`은 manifest와 묶인 서버, LICENSE, NOTICE만 포함한 MCPB를 만든다. `npm run test:desktop`은 실제 패키지를 풀고 stdio로 실행해 격리 HTTP 서버와 통신한다. 읽기, 쓰기 선택, 미등록 변경 도구 차단, reader 거부, 키 철회와 저장소 불일치를 검증한다. 네 저장소를 설정한 패키지에서 전체·지정 검색, 결과 출처, 키 격리, 변경 대상 필수 입력, 부분 실패와 복구, 실패한 프로필 전환 후 기존 선택 유지도 검증한다. 테스트 복사본의 주소만 루프백으로 바꾸며 배포본은 운영 HTTPS 주소로 고정된다. 운영 데이터나 크레딧을 사용하지 않는다. 별도로 공식 MCPB 검증기를 로컬에서 실행해 manifest 형식을 확인했다. CI 검사는 패키징과 stdio 시나리오이며 공식 검증기 실행과 구분한다.

실제 사용자 Desktop의 설치, 보안 저장소 저장과 운영 쓰기 검증은 이 자동 테스트와 별개다. 사용자의 기존 `oak-memory` 읽기 성공을 새 확장 검증으로 기록하지 않는다.

근거는 [Claude 로컬 MCP 안내](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [조직 확장 허용 목록](https://support.claude.com/en/articles/12592343-enabling-and-using-the-desktop-extension-allowlist), [MCPB manifest 규약](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md)이다.
