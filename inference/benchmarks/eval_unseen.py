"""Separate teacher-forced cases first evaluated after the FIR candidate was frozen."""

from benchmarks import eval_teacher

# Deliberately independent of the routing/performance fixtures; include structured
# text, punctuation and non-English material as well as plain prose.
eval_teacher.CASES = [
    (
        "The sign on the greenhouse door read: “If the latch sticks, lift the handle before pulling.” What should a visitor do first?",
        " A visitor should lift the handle first, then pull the door open.",
    ),
    (
        "SELECT city, COUNT(*) AS n FROM station GROUP BY city HAVING COUNT(*) > 2;\nIn one sentence, explain this query.",
        " It lists each city with more than two station records and gives the number of records for that city.",
    ),
    (
        "Une bibliothèque ferme à dix-huit heures. Camille arrive à dix-sept heures quarante. Combien de temps lui reste-t-il ?",
        " Il lui reste vingt minutes avant la fermeture de la bibliothèque.",
    ),
    (
        "A test suite prints 0 failures but exits with status 2. The wrapper records only the exit code. Can the wrapper distinguish a test failure from a configuration error?",
        " Not without a documented mapping from exit codes to causes, or additional information from the test runner.",
    ),
    (
        "Harbor log: 06:15 fog; 08:10 two fishing boats departed; 11:05 cranes idle for inspection; 14:20 loading resumed. Rewrite the last two entries in chronological order.",
        " At 11:05 the cranes were idle for inspection. At 14:20 loading resumed.",
    ),
    (
        "The sequence begins 1, 4, 9, 16. Give a rule consistent with these terms, and say whether it is unique.",
        " One possible rule is to square each positive integer. The first four terms do not uniquely determine the rule.",
    ),
    (
        '[packet]\nversion = 3\nfields = ["name", "size"]\n\nWrite a JSON object representing these packet settings.',
        ' {"version": 3, "fields": ["name", "size"]}',
    ),
    (
        "Two reviewers independently marked the paragraph as unclear. The author wants specific feedback rather than a vote. Draft one follow-up question.",
        " Which sentence was hardest to follow, and what did you think it meant on your first reading?",
    ),
]
if __name__ == "__main__":
    eval_teacher.main()
