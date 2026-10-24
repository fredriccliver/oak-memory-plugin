# OAuth 클라우드 플러그인

`plugins/oak-memory-cloud`를 ChatGPT·Codex와 Claude용 원격 패키지의 기준 소스로
사용한다. 같은 스킬과 `https://www.openaikits.com/api/mcp` 서버를 사용하고 인증과
메모리는 호스팅 OAK 서비스가 처리한다. 이 패키지는 로컬 프로세스·DB·API 키를
요구하지 않는다. 기존 루트 Claude Code 플러그인과 `plugins/oak-memory`의 로컬
Codex 패키지는 유지한다. 로컬 메모리를 클라우드로 이전하거나 동기화하지 않는다.

## 설치와 회사 계정

Claude Desktop 또는 claude.ai에서 Customize → Plugins → Add → Add marketplace에
`https://github.com/fredriccliver/oak-memory-plugin`을 입력하고 동기화한다. 목록의
`oak-memory-cloud`(OAK.memory Cloud)를 선택한다. 기존 `oak-memory`는 로컬 Node
플러그인이므로 원격 OAuth 연결용으로 선택하지 않는다. 플러그인을 활성화한 뒤
OAK 로그인·저장소 동의를 완료하고 새 대화에서 사용한다. 클라우드는
`oak-memory-cloud`, 로컬은 `oak-memory`라는 별도 MCP 이름을 사용한다. 대상 혼동을
줄이려면 한 세션에서 하나만 활성화한다. 다른 플러그인을
비활성화한 뒤 `currentMemoryStore`로 의도한 저장소인지 확인한다.

MCP URL 자체는 Add marketplace의 Git 저장소 입력칸에 넣을 수 없다. 직접 원격
커넥터를 등록할 때는 Customize → Connectors를 사용한다. Team·Enterprise의 조직
커넥터 등록은 Owner·Primary Owner(Enterprise는 해당 Libraries 관리 역할 포함)가
먼저 진행하고 일반 구성원은 등록된 커넥터에 로그인한다.

사용자용 Git 마켓플레이스 설치는 별도 경로지만 회사의 허용·차단 목록과 원격
커넥터 정책이 적용된다. 플러그인 설치가 조직 정책을 우회하거나 OAuth 동의를
생략하는 것은 아니다. 같은 이메일이라도 개인·회사 워크스페이스 연결은 구분한다.

ChatGPT는 portable `plugin.json`·`mcp.json` 패키지를 제출 포털에서 심사·공개해야
한다. GitHub 마켓플레이스 URL을 추가하는 Claude 절차와 같다고 안내하지 않는다.
기존 OpenAI listing의 `oak-memory` 식별자를 유지한다. 준비본 버전 0.1.4의 코드
갱신과 기존 심사본 0.1.2의 심사 상태는 별개이며, 기존 심사 통과 후 새 패키지를
진행한다. manifest의 기존 demo는 이전 빌드 자료이며 0.1.4 병합 검증 증거가
아니다. 새 포털 제출 전 실제 최신 흐름을 확인하고 그에 맞는 demo를 준비한다.
저장소 머지나 서버 배포만으로 설치된 스킬과 listing이 바뀌지 않는다.

## 패키지 검증과 생성

```sh
node scripts/package-cloud-plugin.mjs --check
node scripts/package-cloud-plugin.mjs openai
node scripts/package-cloud-plugin.mjs claude
claude plugin validate plugins/oak-memory-cloud
```

두 ZIP의 공유 스킬은 같은 소스에서 생성한다. OpenAI ZIP은 루트 portable manifest와
MCP 파일, Claude ZIP은 `.claude-plugin/plugin.json`과 `.mcp.json`을 포함한다. 각
호스트의 MCP type 표현은 `streamable-http`와 `http`로 다르며 URL은 동일하다.
명시한 파일만 압축해 로컬 bundle·hook·환경 파일을 포함하지 않는다. 기존 출력은
덮어쓰지 않는다. 포털 업로드와 공개는 별도 단계다.

## 최신 병합 도구

정리 스킬은 호스트에 `mergeMemories`가 노출되면 원자적 병합을 우선한다. 정확한
원문 snapshot, 명시한 UUID와 병합 결과를 입력하고 이후 조회로 확인한다. source UUID
삭제, 중복 edge의 최대 strength 선택, cloud revision 보관과 legacy 저장소의 복구 불가
경계를 설명한다. split과 수동 fallback은 여전히 순차 작업이다. 실제 메모리 병합을
릴리스 검증용으로 실행하지 않는다.

## 실제 완료 기준

설치·도구 목록·OAuth callback만으로 연결 완료를 선언하지 않는다. 실제 호스트에서
`listMemoryStores`로 켜진 동의 저장소를 찾은 뒤, 대상 `storeId`를 명시해 `currentMemoryStore`와 `listMemories`를 호출하고 저장소와 역할을 확인한다.
초기 읽기 동의와 Claude의 도구 실행 승인은 별개이며, 쓰기는 추가 OAuth 동의,
저장소 역할, 서비스 쓰기 허용과 크레딧을 모두 충족해야 한다. 쓰기 테스트는 허용된
합성 내용과 저장소에서만 실행한다. 실제 검증되지 않은 플랫폼은 미확인으로 남긴다.

공식 근거: [Claude 플러그인 설치](https://support.claude.com/en/articles/13837440-use-plugins-in-claude),
[원격 MCP를 포함하는 플러그인](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors),
[Claude 조직 정책](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization),
[OpenAI portable 패키지](https://developers.openai.com/plugins/build/plugins).


## 0.1.5 다중 저장소 검색 준비본

한 OAuth 연결에서 동의한 여러 저장소를 통합 검색하는 호스팅 계약은
[서버 PR #71](https://github.com/fredriccliver/openaikits.com/pull/71)을 따른다.
`recallMemory`의 `storeId` 생략은 통합 검색이고 나머지 작업은 다중 연결에서
호출별 대상을 지정한다. 검색 결과의 출처와 `partial`/`failedStores`를 유지하며
크레딧은 검색한 저장소별로 사용한다. 저장소 정책은 최초 사용 시 그 `storeId`와
`initialize:true`로 한 번 읽고, 이후 단순 정책 조회는 세션 정책을 바꾸지 않는다.

기존 연결은 재동의 전까지 범위가 넓어지지 않는다. 추가 reader 저장소는 쓰기
scope가 있어도 읽기만 가능하다. 0.1.4의 동일 저장소 원자적 병합 지침은 유지한다.
이 소스와 검증용 ZIP은 공개 포털 제출·설치 갱신·실제 호스트 검증 완료를 뜻하지
않으며, 현재 배포 상태는 기존 릴리스 기록과 포털에서 별도로 확인한다.

0.1.5 준비 패키지 후속: 연결별 중지/재개와 저장소별 활성화는 OAK 웹에서 관리한다. 구버전 단일 저장소 호출은 유지하며, 다중 저장소에서 활성 저장소가 하나라도 검색 외 도구는 명시적 storeId가 필요하다. 중지 상태의 401은 호스트에 따라 재연결이 필요할 수 있다. 이 변경은 공개 게시나 호스트 수락 완료를 의미하지 않는다.
