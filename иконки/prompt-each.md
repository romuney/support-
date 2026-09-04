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

One of the attached references shows him at a keyboard. The keyboard is not
part of him: it is there for style only. Never draw a keyboard, a desk, a table
or a laptop unless the line below asks for one.

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

THE BADGE: where the line below starts with the word BADGE and a colour, the
character is not alone on empty background. He sits inside one big round badge
of that colour which fills almost the whole image: a complete filled circle,
centred, its diameter about nine tenths of the width of the image, leaving only
a thin margin of grey background at the four corners. Nothing is drawn outside
the circle, and nothing sticks out of it.

The inside of the badge is not flat. It is a soft radial gradient of that one
colour — lighter and warmer in the middle, behind the head, deeper and more
saturated towards the rim — with a few wide, soft, blurred sunburst rays in a
slightly lighter shade of the same colour fanning out from behind the head. The
rays are diffuse like sunlight through haze, with blurred edges and low
contrast: NOT sharp geometric spokes, NOT hard-edged lines, NOT a striped
pattern. They stay entirely INSIDE the circle, they never touch or cross the rim
and they never stick out of it. A thin lighter rim of the same colour runs
around the inside edge of the badge. All of it stays low in contrast, so that
shrunk to 128 x 128 pixels the badge still reads as one clear solid colour.

The character is drawn in front of the badge, complete and never clipped by its
rim: his cap, both ears, his muzzle, his chest and his paws all sit inside the
circle with a small margin. In a BADGE image the head fills most of the BADGE
rather than most of the frame — that is the one thing the badge is allowed to
change about the framing. Where a mark or an object is listed, it sits inside
the circle too.

Where the line below does not start with BADGE, there is no badge at all: no
circle, no rays, no gradient.

THE PAW: where the line below starts with the word PAW, this overrides the
framing paragraph above. The image does not show his head, his cap or his face
at all. It shows ONE of his front paws alone, in close-up, filling most of the
frame: the same cream fur, the same soft studio lighting and the same 3D render
as the attached references, with soft rounded brown pads. It is a dog's paw, not
a human hand — broad, with short thick toes and visible pads, never human
fingers, never a glove. There is no badge in a PAW image: no circle, no rays, no
gradient, just the paw on flat grey background. Everything in the image is in
sharp focus: there is no depth of field, no blur, and nothing at all behind the
paw — no second paw, no out-of-focus shape, no object in the background.
The wrist and the leg behind the paw are SLIM — clearly
thinner than the paw itself, about half its width — so that the paw stays the
biggest shape in the image. The leg is never as thick as the paw.
Show ONLY the paw itself,
cropped at the wrist: no forearm, no leg, no shoulder, nothing of the rest of
him. The paw is centred and fills most of the frame — it is the same size in
every PAW image, as big as it can be while still leaving clear grey background
on all four sides, and nothing is cut off by any edge.

Change ONLY this: <ЯЧЕЙКА>

BACKGROUND: one flat uniform medium grey (#808080), completely empty. No
gradient, no vignette, no shadow on the background, no ground plane, no
reflections, no extra objects apart from the one described above.

Leave a clear empty margin of background on all four sides: the character, his
ears, his paws, the object and, where present, the round badge must not touch,
overlap or run off the edges of the frame. The grey background must go all the
way around them, unbroken, to all four edges and into all four corners. Nothing may be cut off by the bottom edge: his chest and his
shoulders sit fully inside the frame with grey background below them.

Square image, 1:1 aspect ratio, at the highest resolution available. No caption,
no label, no watermark, no border, no frame.
```

Последний абзац про нижний край — из разбора прогона 02.09: просьбу оставить
поля со всех четырёх сторон модель выполнила по трём, и персонаж почти везде
упирался грудью в нижний край ячейки.

## Плашка для вердиктов

Четыре иконки, которые выносят вердикт, — `bully_done`, `bully_fail`,
`bully_helpful`, `bully_not_helpful` — сделаны не «морда на сером», а **круглой
плашкой**: морда внутри круга цвета кепки, круг во весь кадр, внутри него
мягкий радиальный градиент и размытые солнечные лучи. Подстановка включает
её словом `BADGE` и цветом в начале строки; всё остальное в шаблоне общее.

Плашка появилась потому, что на 128×128 читается цвет, а не предмет — то же
правило, на котором держится весь пак. Круглая заливка отдаёт цвету почти
всю площадь иконки, а не край кепки.

Три захода, и два первых были неправильным прочтением слова «лучи»:

1. **Лучи наружу от круга.** Круг вышел мелким, лучи съели площадь, морда
   на плашке реакции стала крошечной. Лучи — это украшение фона, а не рамка.
2. **Круг «не больше головы с полями» плюс требование «голова занимает
   большую часть кадра».** Два условия несовместимы, и модель разрешала их
   каждый раз по-своему: у одной иконки залитый диск, у другой — тонкое
   кольцо. Из этого правило: **пропорции задавать числом**, а не словами
   «большой» и «маленький».
3. **Круг в девять десятых кадра, лучи внутри него.** Работает. Морда
   крупная, цвет читается первым, вырезание фона снимает только углы —
   и на выходе получается круглая плашка с прозрачными углами, ровно то,
   что нужно реакции в Mattermost.

Лучи описаны как размытые и низкоконтрастные (`NOT sharp geometric spokes`):
чёткие спицы на 128 px превращаются в рябь, а мягкие сливаются в градиент
и просто делают фон живым.

## Обратная связь — лапой, без плашки

Три иконки под ответом бота — `bully_helpful`, `bully_not_helpful`,
`bully_detail` — сделаны иначе всех: **крупная бульдожья лапа во весь кадр,
без морды и без плашки**. Включается словом `PAW` в начале подстановки.

Это кнопки, а не вердикт: на них важен жест, и жесту нужна вся площадь.
Палец вверх у морды на 128 px не читался вовсе — прогон 04.09 это показал, —
а лапа во весь кадр читается сразу. Лапа именно собачья: широкая, с короткими
толстыми пальцами и подушечками, не человеческая рука в перчатке.

**Рука входит сбоку**, а не снизу и не сверху: у пальца вверх и пальца вниз
предплечье уходит к левому краю, и жест отличается только направлением
большого пальца. Когда рука входила снизу у одной и сверху у другой, две
кнопки рядом выглядели как разные наборы.

**Запястье тонкое** — вдвое уже самой лапы. Без этого модель рисует ногу
той же толщины, что и лапа, и на 128 px кадр читается как кусок меха,
а не как жест.

**Якорь для лапы — лапа, а не морда.** Прогон со стилевым якорем-мордой
протащил в кадр кепку с ушами, хотя клауза их прямо запрещает: образец
сильнее запрета. Якорем служит уже принятая лапа (`bully_detail`), и тогда
запрет держится.

Клауза `PAW` отменяет абзац про кадрирование: головы и кепки в таком кадре
нет вовсе. Без этой отмены шаблон требует «голова занимает большую часть
кадра», и модель пририсовывает морду к лапе.

`bully_detail` — та же лапа с ручкой над чистым блокнотом: «написать
подробнее». Блокнот маленький и лежит под лапой: крупная в кадре именно лапа,
иначе на 128 px жест теряется среди канцелярии.

**Размер кисти во всех трёх одинаковый**, и держится он двумя вещами:
клауза требует показать лапу по запястье, без предплечья, а прогон делается
с уже принятой лапой в `--anchor`. Без первого модель дорисовывает лапе
целую руку, и палец вверх выходит вдвое мельче пальца вниз — так и было
на первом прогоне.

## Грусть — ушами и ртом, а не глазами

У `bully_fail` первый прогон дал реалистичные слезящиеся глаза: остальной пак
мультяшный, а тут вдруг настоящая несчастная собака, и иконка выпадала из
набора. Модель поняла «sad apologetic face» как задачу нарисовать грусть
целиком, включая глаза.

Поэтому в подстановке прямо сказано, ЧЕМ грустить: уши вниз, рот скорбной
чертой, **а глаза остаются как на референсах** — огромные, круглые, глянцевые,
с теми же бликами, не реалистичные и не заплаканные. Это общее правило пака:
у выражения есть носители, и глаза в них не входят — их размер и форма
и есть узнаваемость персонажа.

## Светло-серая плашка и вырезание фона

У `bully_unknown` кепка светло-серая, и плашка того же цвета ушла бы
в прозрачность вместе с фоном. Дело не в оттенке: `sheet.key_background`
снимает то, что **нейтрально** (насыщенность ≤ 12), **ровно** (перепад
яркости в окне 3×3 ≤ 8) и **связано с краем кадра** — три признака, каждый
из которых добавлен после конкретного брака, разбор в докстроке функции.
Любой нейтральный серый под эти признаки попадает.

Поэтому плашка у `unknown` описана как светло-серая **с явным холодным
голубым подтоном**: насыщенность выше порога, и проверка на нейтральность
её не берёт независимо от яркости. Прогон 04.09 подтвердил — площадь
непрозрачных пикселей у неё та же, что у зелёной `bully_high`.

## Якорь держит стиль, а не композицию

`--anchor` сначала требовал повторить «стиль, свет и фон» принятой картинки —
формулировка перенесена из листового задания, где фон и правда общий. С плашкой
она спорит: якорь тянул за собой серый фон, а подстановка требовала круг.

Хуже другое: якорем служила иконка из этого же прогона, а она сама уже
подсела по детализации. Через несколько прогонов пак уехал в гладкий плюш —
шерсть без волосков, кепка без фактуры. Копия копии.

Поэтому якорь теперь **только про стиль** и указывает на исходную принятую
картинку, а не на соседнюю по прогону: тот же рендер, шерсть по волоску,
веснушки, усы, фактура кепки, блики в глазах — **а позу, кадр и фон брать
из задания и не копировать у якоря**. Прогон 04.09 с такой формулировкой
вернул детализацию всему паку.

Две утечки из референсов, обе стоили по прогону:

- **Клавиатура.** `bully-style-ref.png` — кадр из анимации «бот печатает»,
  и в `bully_not_helpful` модель положила лапу на клавиатуру. В листовом
  задании запрет есть, в поштучное его забыли перенести. Теперь есть.
- **Вторая лапа в расфокусе.** В `bully_detail` модель добавила глубину
  резкости и размытую лапу на заднем плане; вырезалка сохранила её как
  непрозрачную, и на 128 px это читалось висящим комком. Клауза `PAW`
  теперь требует резкости во всём кадре и пустоты за лапой.

## Шестнадцать подстановок

Порядок и имена — те же, что в `names-c.txt`. Текст ячеек взят из листового
задания слово в слово: он уже прошёл принятый прогон, и переписывать его
заново значило бы заводить вторую версию промпта.

| файл | `<ЯЧЕЙКА>` |
|---|---|
| `bully_ready` | `BADGE blue. Blue denim cap. Chin lifted proudly, chest puffed up, wide happy open smile, one front paw raised in a confident presenting gesture. Nothing else in the image.` |
| `bully_done` | `BADGE green. GREEN denim cap. Eyes closed in a satisfied happy smile, a big bright white check mark beside the head inside the badge.` |
| `bully_fail` | `BADGE red. RED denim cap. Sad apologetic face, ears drooping down, mouth a small unhappy line — the sadness is in the ears and the mouth, NOT in the eyes. The eyes stay exactly as in the attached references: huge, round, glossy, cartoon dark-brown eyes with the same big white highlights. They are not realistic dog eyes, not watery, not teary, not wrinkled, not narrowed. A big bright white cross mark beside the head inside the badge.` |
| `bully_hi` | `BADGE blue. Blue denim cap. One front paw raised high beside the head waving hello, big warm open smile, ears perked up. Nothing else in the image.` |
| `bully_helpful` | `PAW. One front paw entering the frame horizontally from the LEFT side: the short stub of leg runs out to the LEFT edge, so the arm comes in from the side — NOT from below, NOT from above. The paw itself is in the middle of the frame at the end of that leg, making a big thumbs-up: the side toe sticking straight up like a thumb, the other toes curled in, pads facing forward. There is NO head, NO ears, NO cap, NO muzzle, NO body and NO other legs anywhere in the image: only this one paw and the short stub of leg it sits on.` |
| `bully_not_helpful` | `PAW. One front paw entering the frame horizontally from the LEFT side: the short stub of leg runs out to the LEFT edge, so the arm comes in from the side — NOT from below, NOT from above. The paw itself is in the middle of the frame at the end of that leg, making a big thumbs-down: the side toe pointing straight down like a thumb, the other toes curled in, pads facing forward. There is NO head, NO ears, NO cap, NO muzzle, NO body and NO other legs anywhere in the image: only this one paw and the short stub of leg it sits on.` |
| `bully_detail` | `PAW. One front paw entering the frame from the RIGHT side, holding a short thick yellow pen at a natural writing angle of about 45 degrees, the tip of the pen touching the paper and actually writing. Under it a small blank white notepad lying at a slight angle. The paw is the biggest thing in the image and the notepad is small beneath it. No head, no ears, no cap and no other part of him anywhere in the image. The notepad is blank: no writing, no lines, no letters on it.` |
| `bully_search` | `BADGE blue. Blue denim cap. Holding a big magnifying glass up in front of one eye, that eye hugely magnified through the lens, the other eye normal size, focused curious expression.` |
| `bully_high` | `BADGE green. GREEN denim cap. Calm confident closed-mouth smile, eyes bright and steady, ears perked up, head straight. Nothing else in the image at all: no object, no raised paws, no symbol. The green badge is the whole signal.` |
| `bully_mid` | `BADGE amber-yellow. AMBER-YELLOW denim cap. Head tilted to one side, one eyebrow raised higher than the other, mouth a small wavy unsure line, one ear up and one ear half down. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_none` | `BADGE red. RED denim cap. Ears drooping flat, eyes lowered, mouth a small sad apologetic line, shoulders sunk. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_unknown` | `BADGE cool blue-grey — a light grey with a clear cool blue tint, never a neutral or flat grey. Plain LIGHT GREY denim cap, washed out and unpainted. Completely blank puzzled expression, both eyebrows raised high, mouth slightly open, eyes wide and empty. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_flag` | `BADGE red. RED denim cap. Alarmed wide-open eyes, mouth open mid-bark, holding a small bright red flag on a short pole raised beside the head.` |
| `bully_warn` | `BADGE amber-yellow. AMBER-YELLOW denim cap. Worried expression, ears back, a big bright yellow warning triangle with a bold black exclamation mark inside it beside the head.` |
| `bully_lock` | `BADGE blue. Blue denim cap. Holding a big closed golden padlock up just under the chin in both front paws, stern serious expression, one eyebrow raised.` |
| `bully_expert` | `BADGE blue. Blue denim cap. Head turned slightly to one side, one front paw raised pointing off to that side, a big bold yellow arrow beside the head pointing the same way, ears perked up high.` |

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
