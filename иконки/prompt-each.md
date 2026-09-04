# Задание Nano Banana: пачка C по одной картинке за прогон

Те же шестнадцать иконок, что в [`prompt-pack.md`](prompt-pack.md), но не листом
4×4, а шестнадцатью отдельными прогонами. Смысл ячеек, цвета кепок и места
в коде — там же, здесь только форма задания и таблица подстановок.

## Чем это хуже листа и чем лучше

Хуже ровно одним, и это разобрано в `prompt-pack.md`: **шестнадцать прогонов
дают шестнадцать слегка разных персонажей**, а пак обязан выглядеть одним
набором. Лист решает это тем, что все ячейки рисуются в одном проходе.

Лучше — тремя вещами, и они перевешивают, когда пак уже принят и правится
точечно:

1. **Неудачная иконка перекатывается одна.** У листа брак в одной ячейке
   означает перегенерацию всех шестнадцати.
2. **Полное разрешение достаётся одной морде,** а не делится на шестнадцать
   ячеек. Ячейка листа 4K — это ~1000 px, а прогон 2K поштучно даёт 2048 px
   на ту же морду.
3. **Нет разделителей — нет и их брака.** Разбор прогона 02.09: модель
   нарисовала между ячейками белые полосы вместо серых, ячейки разъехались
   на 1003–1014 px, и нарезку пришлось учить искать разделители.

Разъезд стиля сбивается тем же приёмом, что и в `prompt-stickers.md`:
**первый прогон делается один, и когда он устраивает — он прикладывается
третьим референсом ко всем остальным** (`--anchor` у `generate.py`). Два
образца одного стиля сужают модели пространство сильнее, чем один плюс
описание словами.

Начинать с `bully_helpful`: поза простая, кепка перекрашена в зелёный, и по
одной картинке сразу видно и стиль, и главный риск пака — осталась ли белая
надпись CROSS читаемой на перекрашенной кепке.

## Шаблон

Приложить `bulli-ref.png` и `bully-style-ref.png`. Меняется одна строка —
после `Change ONLY this:`.

```
This is the same character as in the attached images. Keep him EXACTLY as he is:
the same 3D render, the same soft studio lighting, the same fur shading and
texture, the same huge glossy dark-brown eyes with the same white highlights,
the same head-to-body proportions with the head filling most of the frame, the
same freckled muzzle, the same big upright ears, the same worn denim baseball
cap with the white embroidered word "CROSS".

Do NOT redraw him. Do NOT restyle him. Do NOT turn him into a 2D illustration,
a painted cartoon, a vector drawing or a printed emoji. No paper texture, no
canvas texture, no glossy print finish, no outline drawing, no flat shading. He
must look like the exact same 3D render as the attached images, only in a
different pose.

Keep the same close-up framing as the attached images: seen from the front at
eye level, the head filling most of the frame, the eyes the same huge size. Do
NOT zoom out, do NOT show a full body, do NOT make the head smaller.

THE CAP: the same worn denim baseball cap, the same shape, the same soft fabric,
with the same white embroidered word "CROSS" on the front, big and clearly
legible. ONLY the dye colour of the fabric changes, exactly as listed below. The
embroidery stays white and readable on any colour. The word "CROSS" is the only
text anywhere in the image: no other letters, no other words. Marks that are
symbols, not text — a check mark, a cross mark, an exclamation mark inside a
warning triangle, an arrow — are fine where listed.

THE OBJECT: where an object is listed, it is big, simple and low detail so that
it stays readable when the image is shrunk to 128 x 128 pixels. It sits beside
the head or enters the frame from the bottom edge, it never covers the eyes or
the cap, and it is the ONLY extra object. Where nothing else is listed, the
image contains the character alone.

Change ONLY this: <ЯЧЕЙКА>

BACKGROUND: one flat uniform medium grey (#808080), completely empty. No
gradient, no vignette, no shadow on the background, no ground plane, no
reflections, no extra objects apart from the one described above.

Leave a clear empty margin of background on all four sides: the character, his
ears, his paws and the object must not touch, overlap or run off the edges of
the frame. Nothing may be cut off by the bottom edge: his chest and his
shoulders sit fully inside the frame with grey background below them.

Square image, 1:1 aspect ratio, at the highest resolution available. No caption,
no label, no watermark, no border, no frame.
```

Последний абзац про нижний край — из разбора прогона 02.09: просьбу оставить
поля со всех четырёх сторон модель выполнила по трём, и персонаж почти везде
упирался грудью в нижний край ячейки.

## Шестнадцать подстановок

Порядок и имена — те же, что в `names-c.txt`. Текст ячеек взят из листового
задания слово в слово: он уже прошёл принятый прогон, и переписывать его
заново значило бы заводить вторую версию промпта.

| файл | `<ЯЧЕЙКА>` |
|---|---|
| `bully_ready` | `Blue denim cap. Chin lifted proudly, chest puffed up, wide happy open smile, one front paw raised into the bottom of the frame in a confident presenting gesture. Nothing else in the image.` |
| `bully_done` | `GREEN denim cap. Eyes closed in a satisfied happy smile, a huge bright green check mark beside the head, as tall as the head itself.` |
| `bully_fail` | `RED denim cap. Ears drooping down, sad apologetic face, a huge bright red cross mark beside the head, as tall as the head itself.` |
| `bully_hi` | `Blue denim cap. One front paw raised high beside the head waving hello, big warm open smile, ears perked up. Nothing else in the image.` |
| `bully_helpful` | `GREEN denim cap. One front paw raised into the frame beside the head giving a big thumbs-up, one eye winking, cheerful grin.` |
| `bully_not_helpful` | `RED denim cap. One front paw raised into the frame beside the head giving a big thumbs-down, mouth a small sorry line, ears half down.` |
| `bully_detail` | `Blue denim cap. Holding a short thick yellow pencil upright in one front paw beside the head and a small blank white notepad in the other front paw, attentive helpful expression, ready to write. The notepad is blank: no writing, no lines, no letters on it.` |
| `bully_search` | `Blue denim cap. Holding a big magnifying glass up in front of one eye, that eye hugely magnified through the lens, the other eye normal size, focused curious expression.` |
| `bully_high` | `GREEN denim cap. Calm confident closed-mouth smile, eyes bright and steady, ears perked up, head straight. Nothing else in the image at all: no object, no raised paws, no symbol. The green cap is the whole signal.` |
| `bully_mid` | `AMBER-YELLOW denim cap. Head tilted to one side, one eyebrow raised higher than the other, mouth a small wavy unsure line, one ear up and one ear half down. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_none` | `RED denim cap. Ears drooping flat, eyes lowered, mouth a small sad apologetic line, shoulders sunk. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_unknown` | `Plain LIGHT GREY denim cap, washed out and unpainted. Completely blank puzzled expression, both eyebrows raised high, mouth slightly open, eyes wide and empty. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_flag` | `RED denim cap. Alarmed wide-open eyes, mouth open mid-bark, holding a small bright red flag on a short pole raised beside the head.` |
| `bully_warn` | `AMBER-YELLOW denim cap. Worried expression, ears back, a big bright yellow warning triangle with a bold black exclamation mark inside it beside the head, as tall as the head itself.` |
| `bully_lock` | `Blue denim cap. Holding a big closed golden padlock up just under the chin in both front paws, stern serious expression, one eyebrow raised.` |
| `bully_expert` | `Blue denim cap. Head turned slightly to one side, one front paw raised pointing off to that side, a big bold yellow arrow beside the head pointing the same way, ears perked up high.` |

## Что пришло с прогона 2026-09-04

Шестнадцать прогонов Nano Banana Pro в 2K, первый — `bully_helpful` без
якоря, остальные пятнадцать с ним третьим референсом. **Стиль устоял во всех
шестнадцати**: один и тот же 3D-рендер, тот же размер глаз, CROSS белый
и читаемый на всех пяти цветах кепки, цвета по таблице, третья строка без
предметов. То есть опасение из `prompt-pack.md` — «шестнадцать прогонов дают
шестнадцать слегка разных персонажей» — якорем снимается.

Вырезание фона прошло без правок: `sheet.key_background` снял серый начисто,
каймы на тёмной теме нет. Файлы 28–34 КБ при пределе Mattermost в 1 МБ —
тот же порядок, что у листового прогона.

Четыре расхождения, все мелкие и ни одно не требует перегенерации:

1. **Кепки приглушённые.** Просили `GREEN`, `RED`, `AMBER-YELLOW` — пришли
   болотный, кирпичный и горчичный. На плашке 128×128 вердикт всё ещё
   читается, но контраст между зелёной и красной ниже, чем на листе. Если
   мешает — добавить в подстановки слово `saturated` или `vivid`.
2. **Блокнот у `bully_detail` не пустой:** промпт трижды просит чистый лист
   («no writing, no lines, no letters»), модель нарисовала линовку. Текста
   на нём нет, так что требование «CROSS — единственный текст» не нарушено.
3. **Палец вниз у `bully_not_helpful` мелкий** и на 128 читается хуже, чем
   галка с крестом у соседей. Кепка при этом красная, и вердикт держится
   на ней — как и задумано правилом пака.
4. **Замок у `bully_lock` сидит низко**, ближе к нижнему краю, чем предмет
   у остальных.

Нижний край, из-за которого на листе почти везде срезало грудь, абзацем
про поля закрыт: во всех шестнадцати под персонажем остался серый фон.

## Прогон

```
# первая иконка — одна, на ней проверяется стиль и читаемость CROSS
python3 generate.py prompt-each.md --each --only bully_helpful --out raw/

# остальные пятнадцать, с принятой первой в качестве третьего референса
python3 generate.py prompt-each.md --each --anchor raw/bully_helpful.png --out raw/

# нарезка каждой в 128x128 с прозрачным фоном
python3 slice_grid.py raw/bully_done.png --cols 1 --rows 1 --names bully_done --out out/
```

Готовые файлы `--each` не перегенерирует: прогон стоит денег, и повтор всей
пачки ради одной неудачной иконки — ровно то, от чего уходили с листа. Чтобы
перекатить одну, файл удаляют и запускают с `--only`.
