# Задание Nano Banana: стикер-пак

## Что сломалось в первой попытке

Лист 3×3 пришёл механически правильным — сетка, серый фон, обводка, ни одной
подписи, CROSS на кепках, позы те. **Разъехался только стиль:** плоский
рисованный стикер с бумажной фактурой, персонаж во весь рост, глаза мелкие,
морда другая. То есть модель не отредактировала приложенную картинку,
а нарисовала своего бульдожку по описанию.

Три причины, и все три в моём промпте:

1. **Слово `sticker`.** Это сильный стилевой токен: он тянет за собой
   печатный стикер — бумажную фактуру, глянец, плоскую заливку. Оно стояло
   в промпте семь раз, включая `die-cut sticker outline`. Ровно это и пришло.
2. **Девять НОВЫХ поз одним листом — это генерация, а не правка.** Когда
   в одной картинке надо придумать девять композиций, приложенный референс
   становится подсказкой, а рисует модель по своему представлению
   о стикер-паке. Идентичность персонажа держится тем сильнее, чем меньше
   меняется за один прогон.
3. **Просил во весь рост, а референс — портрет.** У исходной картинки голова
   занимает почти весь кадр, глаза огромные — в этом вся узнаваемость.
   Тело в референсе не показано, и на просьбу о полном росте модель его
   ДОДУМЫВАЕТ, а вместе с телом переезжают пропорции: голова уменьшается,
   глаза уменьшаются, персонаж становится другим.

Отсюда переделка: **по одному стикеру за прогон, крупным планом, со словом
`sticker` убранным из промпта целиком.** Восемнадцать прогонов вместо двух —
но каждый неудачный перекатывается отдельно, а не всем листом.

Обводку тоже убрал: она была нужна для чистого вырезания фона, а прогон
показал, что серый фон снимается с кремовой шерсти и без неё, без каймы
на тёмной теме. Платить за неё стилевым сломом незачем.

---

## Способ 1 — по одному стикеру (рабочий)

Приложить `bulli-ref.png`. Шаблон один на все восемнадцать, меняется только
строка после `Change ONLY this:`.

```
This is the same character as in the attached image. Keep him EXACTLY as he is:
the same 3D render, the same soft studio lighting, the same fur shading and
texture, the same huge glossy dark-brown eyes with the same white highlights,
the same head-to-body proportions with the head filling most of the frame, the
same freckled muzzle, the same big upright ears, the same worn blue denim
baseball cap with the white embroidered word "CROSS".

Do NOT redraw him. Do NOT restyle him. Do NOT turn him into a 2D illustration,
a painted cartoon, a vector drawing or a printed sticker. No paper texture, no
canvas texture, no glossy print finish, no outline drawing, no flat shading.
He must look like the exact same 3D render as the attached image, only in a
different pose.

Keep the same close-up framing as the attached image: seen from the front at
eye level, the head filling most of the frame, the eyes the same huge size.
Do NOT zoom out, do NOT show a full body, do NOT make the head smaller.

Change ONLY this: <ПОЗА>

Background: one flat uniform medium grey (#808080), completely empty. No
gradient, no vignette, no shadow on the background, no ground plane, no
reflections, no extra objects apart from the one described above.

Leave a clear empty margin of background on all four sides: the character, his
ears, his paws and the prop must not touch, overlap or run off the edges of the
frame.

Square image, 1:1 aspect ratio, at the highest resolution available. The only
text anywhere in the image is the word "CROSS" on the cap. No caption, no
label, no watermark, no border, no frame.
```

### Восемнадцать поз

Каждая написана так, чтобы голова осталась крупной, а предмет входил в кадр
сбоку или снизу — тела в кадре по-прежнему почти нет.

| файл | `<ПОЗА>` |
|---|---|
| `bully_ready` | `chin lifted proudly, chest puffed up, wide happy open smile, one front paw raised into the bottom of the frame in a confident presenting gesture` |
| `bully_yes` | `one front paw raised into the frame beside the head giving a big thumbs-up, one eye winking, cheerful grin` |
| `bully_hmm` | `head tilted to one side, both front paws raised into the bottom of the frame turned palms-up, mouth a small wavy unsure line, eyebrows uneven` |
| `bully_noidea` | `eyebrows raised high, mouth slightly open, both front paws spread into the bottom of the frame, one large bold white question mark floating above the cap` |
| `bully_done` | `a huge bright green check mark beside the head, as tall as the head itself, eyes closed in a satisfied happy smile` |
| `bully_fail` | `a huge bright red cross mark beside the head, as tall as the head itself, ears drooping down, sad apologetic face` |
| `bully_search` | `holding a big magnifying glass up in front of one eye, that eye hugely magnified through the lens, the other eye normal size, focused curious expression` |
| `bully_lock` | `holding a big closed golden padlock up just under the chin in both front paws, stern serious expression, one eyebrow raised` |
| `bully_expert` | `head turned slightly to one side, one front paw raised into the frame pointing off to that side, a big bold yellow arrow beside the head pointing the same way, ears perked up high` |
| `bully_export` | `holding up beside the head a big simple white spreadsheet sheet with a few thick rows and columns drawn on it, helpful businesslike expression` |
| `bully_report` | `a big simple bar chart with three thick bars beside the head, one front paw raised pointing at the tallest bar, explaining expression` |
| `bully_broken` | `the cap knocked crooked and sitting askew, dizzy spiral eyes, small white smoke puffs rising above the cap, one big bold red exclamation mark beside the head` |
| `bully_hi` | `one front paw raised high beside the head waving hello, big warm open smile, ears perked up` |
| `bully_wait` | `holding a big simple steaming mug in both front paws just under the chin, sleepy half-closed eyes, patient bored expression` |
| `bully_facepalm` | `one front paw pressed flat over the eyes and muzzle covering the face, ears flat back, exasperated posture` |
| `bully_thanks` | `hugging a big bright red heart just under the chin in both front paws, eyes closed, blissful happy smile` |
| `bully_nothing` | `holding a big open cardboard box tipped upside down and completely empty beside the head, apologetic shrug, ears slightly down` |
| `bully_idea` | `a big glowing yellow light bulb floating above the cap, bright wide eyes, delighted open-mouth expression, one front paw raised into the frame with the pad up` |

### Приём, который держит стиль дальше

Первый прогон делать **`bully_yes`** — поза простая, и по ней сразу видно,
сохранился стиль или нет. Как только один результат устраивает, дальше
в ТОЙ ЖЕ сессии прикладывать **два** изображения: исходный `bulli-ref.png`
и этот принятый стикер, с фразой:

```
Match the style of both attached images exactly. The second image is the
approved reference for this set.
```

Два образца одного стиля сужают модели пространство сильнее, чем один плюс
описание словами: описание она может понять по-своему, а второй образец
подтверждает, что первый не случайность.

### Нарезка

```
python3 slice_grid.py bully_yes.png --cols 1 --rows 1 --names bully_yes --out out/
```

---

## Способ 2 — всё же одним листом

Если восемнадцать прогонов дорого, лист можно попробовать снова — но с теми
же тремя правками, иначе повторится ровно то же самое. К шаблону выше
добавляется блок сетки:

```
Output ONE single square image containing a strict 3 x 3 grid of 9 versions of
this same character, nine equal square cells, equal outer margins, a uniform
gap between cells, flat uniform medium grey (#808080) across the entire canvas
including the gaps.

In EVERY cell the character is the same close-up portrait as the attached
image: the head fills most of the cell, the eyes stay huge, the framing, the
scale and the lighting are identical in all nine cells. Every cell must look
like the exact same 3D render as the attached image, not a redrawn version of
it. No cell borders, no frames, no grid lines, no numbers, no captions.

The nine cells, reading left to right, top to bottom, differ ONLY in this:
1. …
9. …
```

Ниже — девять строк `<ПОЗА>` из таблицы. Нарезка обычная:

```
python3 slice_grid.py sheet-a.png --names names-a.txt --out out/
```

**Лист принимать только по стилю**, а не по позам: если глаза стали меньше,
появилась фактура бумаги или персонаж во весь рост — переделывать целиком,
починить нарезкой это нельзя.

---

## Что проверить в любом случае

- **глаза того же размера, что в референсе.** Это первое, что уезжает,
  и по нему видно, отредактирована картинка или нарисована заново;
- **никакой фактуры бумаги, холста и глянца** — только 3D-рендер;
- **кепка синяя и с надписью CROSS** — модель теряет надпись чаще всего;
- **фон ровно серый, без градиента и тени под персонажем.** Тень связана
  с фоном не везде, и вырезание оставит серые ошмётки под лапами;
- **персонаж не касается краёв кадра** — иначе обрежется ухо.
