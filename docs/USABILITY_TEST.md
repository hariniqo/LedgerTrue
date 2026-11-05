# 10-minute usability test (do this with 2 or 3 people who are not engineers)

Goal: prove, with real people, that a non-technical person can answer "was this AI helper tricked, and where did the money go?" from a Proof Card.

## Setup
1. `npm start`, open http://localhost:3000, press **Run the demo**, open the **Proof Card** tab.
2. Say only: "An AI helper was given a small school budget. Using this page, answer two questions. I won't help."

## Tasks (time each one)
1. Was the helper ever tricked? What happened to that attempt? (Expected: a gift-card purchase was blocked, no money moved.)
2. Did the helper try to spend something that needed a parent's approval? (Expected: the gaming headset.)
3. How would you check this page wasn't edited? (Expected: scan the QR or press Verify; they may also find the Tamper lab.)

## Record
| Person | Q1 right? | Q2 right? | Q3 right? | Time to finish | One thing that confused them |
|---|---|---|---|---|---|

## Use the result
- If 2 of 3 people get Q1 and Q2 right in under a minute each, say so in the submission and the video: "Tested with N non-technical people: X of N answered correctly in under a minute."
- Report only what actually happened. If someone struggled, fix that screen and say what you changed.
