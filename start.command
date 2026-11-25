#!/bin/zsh
# 더블클릭하면 학습 모니터 서버를 켜고 대시보드를 엽니다. 이 창을 닫으면 종료됩니다.
cd "$(dirname "$0")/supervisor" || exit 1
if ! command -v node >/dev/null; then
  echo "Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 설치해 주세요."
  read -r "?엔터를 누르면 닫힙니다."
  exit 1
fi
# 서버가 준비되면 대시보드를 스스로 엽니다.
SM_OPEN=1 node server.js
