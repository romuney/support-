# Задание Nano Banana: стикер-пак

Приложить `bulli-ref.png`. Просить **PNG в максимальном разрешении**
(если предлагается 2K — брать 2K: при сетке 3×3 это 680 px на ячейку
против 341, а нам нужен запас на die-cut контур).

Две пачки по 9 — **не одна на 18**. Причина не в лени модели: чем больше
ячеек, тем меньше пикселей на персонажа, и на 4×4 морда уже разъезжается
между ячейками. Девять — предел, при котором Nano Banana держит одного
и того же бульдожку.

Промпты ниже — **на английском намеренно**: у Nano Banana на английском
заметно выше следование ограничениям вида «no text», «no cell borders»,
а именно они здесь и решают, придётся ли переделывать.

---

## Пачка A — процесс обращения

```
Use the attached image as the exact character reference. Every cell must show
the SAME character: a 3D Pixar-style cartoon French bulldog, cream and tan fur,
big glossy brown eyes, dark brown nose, freckled muzzle, oversized upright ears,
wearing a worn blue denim baseball cap with the white embroidered word "CROSS"
on the front panel.

Output ONE single square image, 1:1 aspect ratio, at the highest resolution
available.

LAYOUT: a strict 3 x 3 grid of 9 separate sticker poses. Nine equal square
cells, equal outer margins, a uniform gap between cells. Each character is
centred inside its own cell with a small empty margin, never touching the cell
edges. All nine characters are at exactly the SAME scale, the same frontal
camera distance and the same eye level, lit by the same soft studio light.
No cell borders, no frames, no grid lines, no numbers, no captions, no labels,
no watermark, no signature. The ONLY text anywhere in the whole image is the
word "CROSS" on the cap.

BACKGROUND: one flat uniform medium grey (#808080) filling the entire canvas
including the gaps between the cells. No gradient, no vignette, no drop shadow
on the background, no ground plane, no reflections.

Every character has a clean, even white die-cut sticker outline about 8 pixels
thick around its full silhouette, including any prop it holds.

PROPS must be large, simple and high contrast: each sticker has to stay readable
when scaled down to 128 x 128 pixels. No small details, no thin lines, no tiny
objects, no fine text.

The nine cells, reading left to right, top to bottom:

1. Answer is ready: sitting upright, chest puffed out proudly, chin high, one
   front paw raised in a confident presenting gesture, wide happy smile.
2. Confident yes: one front paw raised in a big thumbs-up, one eye winking,
   cheerful grin.
3. Not sure: head tilted to one side, shoulders shrugged, both front paws turned
   palms-up, mouth a small wavy unsure line.
4. No idea: both front paws spread wide apart, eyebrows raised high, one large
   bold white question mark floating above the head.
5. Solved: standing beside a huge bright green check mark almost as tall as the
   dog, eyes closed in a satisfied happy smile.
6. Not solved: standing beside a huge bright red cross mark almost as tall as
   the dog, ears drooping, sad apologetic face.
7. Searching: holding a big magnifying glass in front of one eye, that eye
   hugely magnified through the lens, focused curious expression.
8. Locked, needs approval: holding a big closed golden padlock in both front
   paws in front of the chest, serious stern expression, one eyebrow raised.
9. Call the expert: one front paw pointing off to the side, a big bold yellow
   arrow beside it pointing the same way, alert helpful expression, ears perked
   up high.
```

Порядок имён для нарезки — `names-a.txt`.

---

## Пачка B — тематические и человеческие

Тот же промпт целиком, заменяется только список из девяти ячеек:

```
1. Data export: holding up a big simple spreadsheet document with a few thick
   rows and columns drawn on it, businesslike helpful expression.
2. Report: standing beside a large simple bar chart with three thick bars,
   one front paw pointing at the tallest bar, explaining expression.
3. Broken: dazed and rumpled, cap knocked crooked, small white smoke puffs
   above the head, spiral dizzy eyes, one big bold red exclamation mark beside
   the head.
4. Hello: waving one front paw high in a friendly greeting, big warm open smile,
   ears perked up.
5. Waiting: sitting behind a big simple steaming mug held in both front paws,
   sleepy half-closed eyes, patient bored expression.
6. Facepalm: one front paw covering the whole face, other paw hanging down,
   ears flat, exasperated posture.
7. Thank you: hugging a big bright red heart against the chest with both front
   paws, eyes closed, blissful happy smile.
8. Nothing like that: holding a big open cardboard box tipped upside down and
   completely empty, shrugging, apologetic expression.
9. Idea: a big glowing yellow light bulb floating above the head, one front paw
   raised with the pad up as if it just realised something, bright wide eyes,
   delighted expression.
```

Порядок имён для нарезки — `names-b.txt`.

---

## Что проверить в результате до нарезки

Сверять глазами, а не на веру — переделать лист дешевле, чем чинить
восемнадцать PNG:

- **фон ровно серый и связный**, в том числе в промежутках между ячейками.
  Если модель подложила градиент или тень под персонажа — вырезание фона
  оставит серую подложку, и на тёмной теме Mattermost это будет заметный
  прямоугольник;
- **ни одной подписи, номера и рамки ячейки.** Текст врисован в пиксели,
  из эмодзи он потом не убирается;
- **кепка везде синяя и с надписью CROSS.** Модель любит терять надпись
  на дальних ячейках;
- **персонаж не касается краёв ячейки** — иначе нарезка срежет ухо;
- **все девять одного размера.** Разнобой масштаба в паке виден сразу:
  реакции стоят в ряд, и мелкий бульдожка среди крупных читается как брак.
