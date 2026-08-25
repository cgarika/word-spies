# Word Spies
Team word-deduction for 4-12 humans (no bots — bots can't lie about words).
25 words, secret 9/8/7/1 map, two spymasters giving one-word clues, teams
arguing out loud and tapping. Hit the trap word and it's over instantly.
Teams and spymasters are drawn at random every game and every rematch.
A leaving spymaster hands the map to a teammate; an emptied team forfeits.

Secrecy is server-enforced: guessers' state never contains the key
(test/rules.js proves it with hostile clients), and the map goes public
only at game over.

Run: npm install && node server.js   (PORT, CLUE_MS, GUESS_MS, BASE_PATH)
Deployed at needasix.com/spies behind the arcade proxy (BASE_PATH=/spies).
