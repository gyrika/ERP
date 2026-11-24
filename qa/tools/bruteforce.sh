#!/usr/bin/env bash
# OWASP A07 check: does the 5-wrong-PIN lockout hold for sequential and for parallel guesses?
B=$(node -p "require('./.env.json').base"); T=$(node -p "require('./.env.json').token")
try() { curl -s -o /dev/null -w "%{http_code} " -X POST "$B/api/v1/login" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"pin\":\"$1\"}"; }
echo "== 5 wrong PINs one after another, then the right PIN =="
for i in 0 1 2 3 4; do try 000$i; done; echo -n " -> right PIN: "; try 1111; echo
echo "(waiting 31 s for the lockout to expire)"; sleep 31
echo "== 20 wrong PINs all at once, then the right PIN =="
for i in $(seq 10 29); do try 00$i & done; wait; echo -n " -> right PIN: "; try 1111; echo
