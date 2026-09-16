---
order:    0063
to:       firebase
issued:   2026-09-16
blocking: yes
---

# The rollup probe found something bigger than the rollup: tasks cannot be created.

I ran `scripts/run-rollup-probe.sh` against production, which is what closed your stated gap. It
failed on its first append:

```
StoreError: unknown event kind: task_created
```

**The probe is wrong** — `task_created` is not in `LAYER_OF`. But chasing it surfaced the real thing.

## `addTask` exists only in the in-memory test store

- `shared/store/memory.ts:196` — the fake
- `functions/src/webhook.test.ts` — a test
- `firebase/seed-demo.ts` — a seeder

**Nothing in the CLI, the port, or the write function creates a task.** `flotilla claim <task_id>`
takes an id that nothing can bring into existence. Every task the board has ever shown came from a
seeder or a fixture.

The user just created a real project on a real repo. Their board will have **six empty columns and
no way to fill them.** That is the product's first-run experience.

## What to build

1. **`createTask` on the port**, with the conformance coverage every other operation has.
2. **An event kind for it.** Coordination layer — it creates work an agent must see, same reasoning
   that put an accepted client suggestion on the contract layer and a declined one on the human
   layer. Then `LAYER_OF` has it and the probe's guess becomes correct rather than invented.
3. **`flotilla task <title> --kind <role>`**, and in `--help`.
4. **The rollup counters must move on it.** Your delta function is pure and tested; a new kind that
   does not increment `open` would be a counter that silently drifts — the exact failure you bounded
   everything else against.
5. **Fix the probe** to use the real kind, then run it. Your gap stays open until it does.

## Where tasks should come from, longer term

State an opinion, do not build it yet. The client seat files suggestions, an owner triages them into
tasks, and an architect publishes contracts that imply work. All three end at "create a task", and
it should be one path, not three. **Say which one you think it is** and record it — a second
definition of how work appears is the shape of defect this project has paid for repeatedly.

## Also

Two things the last run got right and should survive any edit here: counters move by **delta, not
recount**, so cost is O(1) and `FieldValue.increment` composes where read-modify-write would drop a
concurrent append. And the index reads **1 query + 3 reads per project**, independent of task count.
Do not let `createTask` reintroduce a recount.

Standing: assert the artifact. A control that never fires has not been run. State which of your
claims are tested and which are *verified against production* — that distinction is exactly what
made this run worth it.
