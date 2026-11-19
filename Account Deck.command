#!/bin/zsh -l
# Double-click to start Account Deck and open it in the browser.
cd "$(dirname "$0")"
(sleep 1 && open "http://127.0.0.1:4777") &
exec node server.mjs
