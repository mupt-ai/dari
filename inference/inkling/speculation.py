"""Choose each round's draft depth from measured round cost and acceptance.

A round yields its accepted drafts plus one target token. Deeper drafts accept
more tokens per round but verify more rows, which costs more as the experts
they route to grow, so pick the depth with the most expected tokens per
millisecond. Costs and per-position acceptance are running averages; untried
depths are measured once, and a neighbour of the chosen depth is retried
periodically so the choice can move as the context or the text changes.
"""

COST_RATE, COST_STEP = 0.3, 0.25
ACCEPT_RATE, ACCEPT_SAMPLES = 0.1, 8
PROBE_EVERY = 16


class Depth:
    def __init__(self, limit):
        self.limit = limit
        self.cost = {}  # depth -> running ms per round
        self.timed = {}  # depth -> rounds measured
        self.rate = [0.0] * (limit + 1)  # P(position i accepted | i - 1 was)
        self.seen = [0] * (limit + 1)
        self.rounds = 0

    def acceptance(self, i):
        for j in range(i, 0, -1):
            if self.seen[j] >= ACCEPT_SAMPLES:
                return self.rate[j]
        return 1.0

    def tokens(self, depth):
        total = chance = 1.0
        for i in range(1, depth + 1):
            chance *= self.acceptance(i)
            total += chance
        return total

    def ms(self, depth):
        known = sorted(self.cost)
        lower = max((d for d in known if d <= depth), default=known[0])
        upper = min((d for d in known if d >= depth), default=known[-1])
        if lower == upper:
            return self.cost[lower]
        t = (depth - lower) / (upper - lower)
        return self.cost[lower] + t * (self.cost[upper] - self.cost[lower])

    def next(self):
        self.rounds += 1
        for depth in range(self.limit + 1):
            if depth not in self.cost:
                return depth
        best = max(range(self.limit + 1), key=lambda d: self.tokens(d) / self.ms(d))
        if self.rounds % PROBE_EVERY == 0:
            return (
                min(best + 1, self.limit)
                if self.rounds % (2 * PROBE_EVERY)
                else max(best - 1, 0)
            )
        return best

    def observe(self, depth, accepted, ms):
        old, n = self.cost.get(depth), self.timed.get(depth, 0)
        self.timed[depth] = n + 1
        if n < 3:
            # Average the first few rounds before trusting a single one.
            self.cost[depth] = ms if old is None else old + (ms - old) / (n + 1)
        else:
            step = COST_STEP * old
            self.cost[depth] = old + COST_RATE * max(-step, min(step, ms - old))
        for i in range(1, min(accepted + 1, depth) + 1):
            hit = float(i <= accepted)
            self.rate[i] = (
                hit
                if not self.seen[i]
                else self.rate[i] + ACCEPT_RATE * (hit - self.rate[i])
            )
            self.seen[i] += 1
