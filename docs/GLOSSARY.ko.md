# 한국어 용어집

Mac(App/·Core 의 Localizable.xcstrings)과 Electron(ko.extra.json → gen-i18n.mjs → ko.json)이 같은 말을 쓴다.
키(영어)는 그대로 두고 한국어 값만 이 표에 맞춘다. 새 문구도 이 표를 따른다. (wave4 w4-input, 감사 polish-04 · comp-20)

| 영어 | 한국어 | 뜻 / 쓰지 않는 말 |
|---|---|---|
| Review | 리뷰 | 파일 리뷰 전체. "검토"는 쓰지 않는다. 그냥 "살펴보다"는 "확인" |
| Pending (review) | 리뷰 대기 / 대기 | 아직 판정하지 않은 파일 |
| Accept | 수락 | 리뷰 판정. 디스크는 그대로. "승인"은 쓰지 않는다 |
| Reject | 거절 | 리뷰 판정. 파일을 턴 시작 상태로 되돌린다. "되돌리기"라고 하지 않는다 |
| Revert (part / hunk) | 되돌리기 · 부분 되돌리기 | 디스크의 파일(일부)을 되돌림 |
| Rewind | 대화 되돌리기 | 대화·체크포인트를 이 메시지 앞으로. 파일 되돌리기는 그 안의 선택지 |
| Request changes | 변경 요청 | "수정 요청"은 쓰지 않는다 |
| (review) note | (리뷰) 메모 | "노트"는 쓰지 않는다(노트북 셀은 예외) |
| Approve | 승인 | 계획·권한 요청에만 쓴다 |
| Accept edits (권한 모드) | 편집 바로 허용 | 편집을 묻지 않고 허용할 뿐, 리뷰는 그대로다. 리뷰의 "수락"과 섞지 않는다 |
| Workbench | 워크벤치 | "작업대"는 쓰지 않는다 |
| Remote | 원격 (저장소) | "리모트"는 쓰지 않는다 |
| Idle | 쉬는 중 | 파일의 "대기"와 섞지 않는다 |
| Effort | 추론 강도 | "노력 수준"은 쓰지 않는다 |
| Refresh | 새로고침 | 붙여 쓴다 |
| sidecar | 엔진 | 내부 이름은 사용자 문구에 드러내지 않는다 |
| Side question | 곁질문 | |
| Auto (model) | 자동 (모델) | 메시지마다 모델을 고른다(§43.4). 칩은 "자동 · sonnet". 권한 모드의 "자동"과 섞이지 않게 모델 이름을 같이 쓴다. 정책은 비용 우선 · 균형 · 품질 우선 |
| Agent Board | 관제판 | 에이전트 · 서브브레인 · 코드 그래프 탭이 있는 창(§43). Mac 창 › 관제판(⌥⌘B), Windows 보기 › 관제판(Ctrl+Alt+B). "대시보드"는 쓰지 않는다 |
| Sub-brain | 서브브레인 | Claude Code 의 자동 메모리(저장소마다 하나, 워크벤치가 같이 쓴다, §43.2). 폴더를 말할 때만 "자동 메모리 폴더" |
| Code graph | 코드 그래프 | graphify 가 만든 리포트(§43.3). 다시 만드는 것은 "다시 빌드" |
| Status line | 상태줄 | 사용자의 Claude Code `statusLine` 명령이 그린 줄(§44.2). 입력창 아래. 앱 자체의 HUD 와 섞지 않는다. 설정 이름은 "Claude Code 상태줄" |

경과 시간은 "3분 20초 · 1시간 2분 · 12.3초"(영어는 "3m 20s"), Mac 은 Core 의 `ElapsedFormat`, Electron 은 `formatElapsed`.
