# Задание Nano Banana: пак v2, по одной картинке за прогон

**Это единственное живое задание пака.** Шестнадцать иконок, тринадцать
с круглой плашкой и три лапой, по прогону на иконку. Форма кадра, канон
персонажа, палитра и подстановки — здесь и только здесь.

Соседние задания не запускаются и остаются как разбор: `prompt-pack.md` —
первая редакция пака (цвет нёс кепку) с таблицей «Где это живёт в коде»,
`prompt-pack-v2.md` — заход на плашку листом 4×4, который до прогона
не дошёл. Смысл ячеек и места в коде — в `prompt-pack.md`.

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

Якорь — **эталон пака `bully_done`**: он один показывает сразу и персонажа,
и то, как морда стоит в плашке. По первой картинке видно всё, что задаётся
шаблоном, — крупность морды, стоячие уши, читаемость белого CROSS
на перекрашенной кепке.

## Шаблон

Приложить `bulli-ref.png` и `bully-style-ref.png`. Меняется одна строка —
после `Change ONLY this:`.

```
This is the same character as in the attached images. Keep him EXACTLY as he is:
the same 3D render, the same soft studio lighting, the same fur shading and
texture, the same huge glossy dark-brown eyes with the same white highlights,
the same head-to-body proportions with the head filling most of the frame, the
same freckled muzzle, the same big upright bat ears, the same worn denim
baseball cap with the white embroidered word "CROSS".

THE EARS ARE PART OF WHO HE IS, NOT PART OF HIS MOOD. In every image both ears
are the same big, wide, upright French bulldog bat ears standing straight up
off the top of his head, exactly as in the attached references — the same
shape, the same size, the same angle, in every single image. They are NEVER
drooping, NEVER folded, NEVER hanging down beside his cheeks, NEVER floppy
hound ears, NEVER one up and one down, and never different from one image to
the next. Sadness, worry and confusion are shown by the mouth, the eyebrows,
the tilt of the head and the shoulders — never by the ears.

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
legible. ONLY the dye colour of the fabric changes, exactly as listed below.
The cap is always a DEEPER shade than the badge behind it — clearly darker, so
it stands out against it and never melts into it. The embroidery stays white
and readable on any colour. The word "CROSS" is the only
text anywhere in the image: no other letters, no other words. Marks that are
symbols, not text — a check mark, a cross mark, an exclamation mark inside a
warning triangle, an arrow — are fine where listed.

THE OBJECT: where an object is listed, it is FLAT MATTE WHITE — pure white,
whatever colour such a thing would normally be — so that it stays visible on
any badge colour. It is about ONE THIRD of the diameter of the badge — big enough
to read when the image is shrunk to 21 x 21 pixels, small enough that it never
makes the head smaller and never makes him thinner. Simple and low on detail, a silhouette rather than
a drawing. It sits in the lower half of the badge beside the muzzle, in FRONT
of him, and it may overlap his jowl or his chin; it never covers his eyes or
his cap, it never pushes him back or down, and it is the ONLY extra object. Where nothing else is listed, the image contains the
character alone.

THE BADGE: where the line below starts with the word BADGE and a colour, the
character is not alone on empty background. He sits inside one big round badge
of that colour which fills almost the whole image: a complete filled circle,
centred, its diameter about nine tenths of the width of the image, leaving only
a thin margin of grey background at the four corners.

The badge has three zones, from the edge inwards, and the first of them is what
makes it look like a badge at all:

1. **A THICK, VIVID RIM.** A bold ring of strong saturated colour running all
   the way around the edge of the circle. It is THICK — about one twentieth of
   the badge's diameter, a band you notice, not a hairline. It is the most
   SATURATED colour in the whole image, and clearly DARKER than the field
   inside it. Its exact colour is named for each image below. This rim is what
   makes the badge read as a badge at 21 x 21 pixels; without it the icon
   looks like a pale washed-out blob.
2. **A BRIGHT FIELD** just inside the rim, in the lighter, less saturated shade
   named below. The rim does not fade into it — it is a distinct band with
   a visible inner edge.
3. **A PALER, SOFTER CENTRE** behind his head, where the field lightens and
   desaturates so that it does not compete with him. The transition from the
   bright field to the pale centre is smooth.

So the colour runs vivid at the edge, bright next to it, pale behind the dog.
Nothing else is drawn inside the circle: no rays, no spokes, no stripes,
no pattern, no white.

THE CHARACTER IN THE BADGE: he is chubby, round-cheeked and cute, with heavy
soft jowls, drawn at the same size and the same distance as in the attached
images — head large in the frame, his cap and both ears reaching the rim of the
badge, his chest and the tops of his front paws showing below his muzzle. Do
NOT slim him down, do NOT tighten the crop around his face, do NOT zoom out and
leave a ring of empty badge colour above his cap.

Where the line below does not start with BADGE, there is no badge at all: no
circle, no rays, no gradient.

THE PAW: where the line below starts with the word PAW, this overrides the
framing paragraph above. The image does not show his head, his cap or his face
at all, and there is no badge: no circle, no rim, no gradient — just the paw on
flat grey background.

FRAME IT LIKE A STANDARD EMOJI, because that is what it is. Think of the
everyday thumbs-up emoji: the hand alone, very close, filling almost the whole
square, and nothing else in the picture. Same here. THE PAW ITSELF — the pad
and the toes — fills at least three quarters of the width and three quarters of
the height of the frame, so that at 21 x 21 pixels the gesture alone is what
you see.

Of the leg show ONLY A SHORT STUB OF WRIST, and it is SMALL: no more than about
a fifth of the height of the frame, just enough to say where the paw is
attached. There is NO forearm, NO leg, NO arm crossing the frame and nothing
running out to a side edge. Zoom right in on the paw.

The wrist enters the way it does in the everyday emoji: for a thumbs-up from
the BOTTOM edge, for a thumbs-down from the TOP edge. Everything else about the
two is identical — the same paw, the same size, the same place in the frame,
the same light — so that the pair reads as one set turned over.

IT IS A DOG'S PAW AND NEVER A HAND. It is broad and chunky, with FOUR short
thick rounded toes of roughly equal length and a big soft pad: the same cream
fur with the same visible individual hairs, the same soft studio lighting and
the same 3D render as the attached references, with soft rounded dark-brown
pads. There are NO fingers: no long jointed fingers, no separated fingers, no
knuckles, no fingernails, no opposable thumb, no human wrist, no bare human
skin, no glove. It is covered in fur everywhere except the pads. Where the paw
holds something, it holds it CLAMPED BETWEEN THE TOES and pressed against the
pad, the way a dog holds a stick — it never grips it with fingers.

Everything in the image is in sharp focus: there is no depth of field, no blur,
and nothing at all behind the paw — no second paw, no out-of-focus shape, no
object in the background. Apart from the short wrist stub at its one edge,
leave a small even margin of grey on all four sides, and nothing else is cut
off by any edge.

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

## Плашка: тринадцать из шестнадцати

**Плашка у всех, кроме трёх иконок обратной связи.** Тринадцать — морда
внутри круга: круг во весь кадр, внутри него мягкий радиальный градиент
и размытые солнечные лучи. Подстановка включает плашку словом `BADGE`
и цветом в начале строки; всё остальное в шаблоне общее. Три (`bully_helpful`,
`bully_not_helpful`, `bully_detail`) идут лапой без плашки — раздел ниже.

Плашка появилась потому, что на 128×128 читается цвет, а не предмет — то же
правило, на котором держится весь пак. Круглая заливка отдаёт цвету почти
всю площадь иконки, а не край кепки.

**Морда крупнее плашки, и плашка её режет.** Эталон — `bully_done` из прогона
06.09: козырёк кепки идёт от ободка до ободка, кончики ушей и макушка кепки
упираются в ободок и им обрезаны, глаза стоят на горизонтальной оси круга.
Ровно этого просит владелец словом «крупный бульдожка», и ровно это шаблон
до 06.09 запрещал: он требовал, чтобы персонаж целиком помещался внутрь круга
с полями, — и десять иконок из тринадцати вышли мелкой мордой посреди пустой
заливки. `bully_done` получился хорошим потому, что модель эту фразу
нарушила. Правило переписано под эталон и задано числом: девять десятых
диаметра по кончикам ушей, семь десятых по козырьку.

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
а лапа во весь кадр читается сразу.

**Лапа собачья, и пальцев у неё нет.** В прогоне 06.09 `bully_detail` пришёл
человеческой кистью: длинные пальцы с суставами, голая кожа, ручка в щепоти.
Запрет «не человеческая рука» в шаблоне стоял, но рядом стояла задача
«держит ручку», а держать ручку без пальцев модель не умеет — и выбрала
пальцы. Соседние две от этого тоже поехали: у них лапа вышла безволосой
бежевой культёй, ближе к предплечью, чем к лапе.

Поэтому запрет теперь перечислимый — четыре коротких толстых пальца равной
длины, подушечка, шерсть везде, кроме подушечек; нет суставов, ногтей,
противопоставленного большого, голой кожи, — **а задача переписана под него**:
ручка не в щепоти, а **зажата между пальцами и прижата к подушечке**, как
собака держит палку. Запретить позу, оставив задачу, которая её требует,
не работает: у модели выигрывает задача.

**Рука у всех трёх входит слева.** Раньше у пальца вверх и вниз она уходила
к левому краю, а у `bully_detail` — к правому: три кнопки в ряд выглядели
как два разных набора.

**Запястье тонкое** — вдвое уже самой лапы. Без этого модель рисует ногу
той же толщины, что и лапа, и на 128 px кадр читается как кусок меха,
а не как жест.

**Одно исключение из «ничего не срезано краем» — эта самая нога.** Абзац
про поля со всех четырёх сторон и требование «предплечья не видно, лапа
обрезана по запястье» противоречили друг другу, и модель разрешала спор
по-своему: рисовала длинное предплечье через весь кадр. Теперь сказано
прямо: нога уходит за левый край и только за него, сверху, снизу и справа
фон остаётся.

**Якорь для лапы — лапа, а не морда.** Прогон со стилевым якорем-мордой
протащил в кадр кепку с ушами, хотя клауза их прямо запрещает: образец
сильнее запрета. Якорем служит уже принятая лапа (`bully_detail`), и тогда
запрет держится.

Клауза `PAW` отменяет абзац про кадрирование: головы и кепки в таком кадре
нет вовсе. Без этой отмены шаблон требует «голова занимает большую часть
кадра», и модель пририсовывает морду к лапе.

`bully_detail` — та же лапа с карандашом над чистым блокнотом: «написать
подробнее». Блокнот маленький и лежит под лапой: крупная в кадре именно лапа,
иначе на 128 px жест теряется среди канцелярии.

**Размер лапы во всех трёх одинаковый**, и держится он двумя вещами: клауза
требует одну и ту же лапу на одном и том же месте, а прогон делается с уже
принятой лапой в `--anchor`. Без этого палец вверх выходит вдвое мельче
пальца вниз — так и было на первом прогоне; в прогоне 06.09 разница осталась
в высоте кадра (110 px против 94 px у `bully_detail`) — блокнот съел место.

## Мимика — ртом и бровями. Ни глаза, ни уши в неё не входят

У `bully_fail` первый прогон дал реалистичные слезящиеся глаза: остальной пак
мультяшный, а тут вдруг настоящая несчастная собака, и иконка выпадала из
набора. Модель поняла «sad apologetic face» как задачу нарисовать грусть
целиком, включая глаза.

Поэтому в подстановке прямо сказано, ЧЕМ грустить, **а глаза остаются как
на референсах** — огромные, круглые, глянцевые, с теми же бликами,
не реалистичные и не заплаканные. У выражения есть носители, и глаза
в них не входят: их размер и форма и есть узнаваемость персонажа.

**С ушами вышло то же самое, и разобрано это только 06.09.** Прежняя
редакция сама предписывала грустить ушами: `ears drooping down` у `fail`,
`ears drooping flat` у `none`, `one ear up and one ear half down` у `mid`,
`ears back` у `warn`. Модель выполнила это буквально — и опустила не уши,
а породу: у французского бульдога стоячие уши и есть силуэт, а с висячими
получается гончая. В паке из шестнадцати иконок четыре оказались с другой
собакой, и владелец увидел ровно это — «немножко разные персонажи».

Уши приравнены к глазам: **в мимике не участвуют вовсе.** Во всех шестнадцати
они одинаковые — большие, широкие, стоячие, того же размера и наклона, что
на референсах. Грусть, тревога и растерянность рисуются ртом, бровями,
наклоном головы и плечами. Запрет стоит в шаблоне, а не в подстановках:
подстановка задаёт, что в иконке своё, шаблон — что во всех общее, и уши
общие.

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
| `bully_ready` | `BADGE with a thick vivid rim #395B7A and a field of soft denim blue #6690B5. Cap dyed deeper slate blue #6A7A8C. Chin lifted proudly, wide happy open smile, one front paw raised in a confident presenting gesture. No object.` |
| `bully_done` | `BADGE with a thick vivid rim #40814C and a field of light sage green #95A67A. Cap dyed deeper green #698265. Eyes closed in a satisfied happy smile, a big flat WHITE check mark beside the muzzle in the lower half of the badge.` |
| `bully_fail` | `BADGE with a thick vivid rim #86322D and a field of light warm red #CA6660. Cap dyed deeper red #A8504E. Sad apologetic face: mouth a small unhappy downturned line, eyebrows pulled up in the middle, head dipped slightly. The ears stay big and upright exactly as in the references, and the eyes stay exactly as in the references — huge, round, glossy, cartoon dark-brown with the same big white highlights. They are not realistic dog eyes, not watery, not teary, not narrowed. A big flat WHITE cross mark beside the muzzle in the lower half of the badge.` |
| `bully_hi` | `BADGE with a thick vivid rim #395B7A and a field of soft denim blue #6690B5. Cap dyed deeper slate blue #6A7A8C. One front paw raised high beside the muzzle waving hello, big warm open smile. No object.` |
| `bully_helpful` | `PAW. A big clear thumbs-up framed like the standard thumbs-up emoji: the paw seen from the side and filling the frame, the outer toe stretched straight UP like a thumb, the other toes curled in towards the pad. Only a short stub of wrist at the BOTTOM edge — no forearm, no leg. Nothing else in the image.` |
| `bully_not_helpful` | `PAW. A big clear thumbs-down framed like the standard thumbs-down emoji: the SAME paw as the thumbs-up at the same size and in the same place, turned over — the outer toe stretched straight DOWN like a thumb, the other toes curled in towards the pad. Only a short stub of wrist at the TOP edge — no forearm, no leg. Nothing else in the image.` |
| `bully_detail` | `PAW. The same paw filling the frame the same way, holding a short thick yellow pencil clamped between two of its toes and pressed against the pad, tilted as if about to write — no fingers grip it. Only a short stub of wrist at the BOTTOM edge. Under the pencil tip a small blank white notepad, clearly smaller than the paw. The notepad is completely blank: no writing, no ruled lines, no letters on it.` |
| `bully_search` | `BADGE with a thick vivid rim #395B7A and a field of soft denim blue #6690B5. Cap dyed deeper slate blue #6A7A8C. Holding up a big magnifying glass with a thick flat WHITE rim and a white handle, at least half the diameter of the badge, in front of one eye; that eye hugely magnified through the clear lens, the other eye normal size, focused curious expression.` |
| `bully_high` | `BADGE with a thick vivid rim #40814C and a field of light sage green #95A67A. Cap dyed deeper green #698265. Calm confident closed-mouth smile, eyes bright and steady, head straight. Nothing else in the image at all: no object, no raised paws, no symbol. The green badge is the whole signal.` |
| `bully_mid` | `BADGE with a thick vivid rim #AD6B25 and a field of light amber #DDA060. Cap dyed deeper amber #C28B48. Head tilted to one side, one eyebrow raised higher than the other, mouth a small wavy unsure line. Both ears stay big and upright. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_none` | `BADGE with a thick vivid rim #86322D and a field of light warm red #CA6660. Cap dyed deeper red #A8504E. Eyes lowered, mouth a small sad apologetic line, head dipped. Both ears stay big and upright. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_unknown` | `BADGE with a thick vivid rim #4F7090 and a field of light blue-grey #8DA3B8, clearly BLUE-grey and never a neutral, flat or silver grey. Cap dyed plain washed-out grey #808790. Washed out and unpainted. Completely blank puzzled expression, both eyebrows raised high, mouth slightly open, eyes wide and empty. Nothing else in the image at all: no object, no raised paws, no symbol.` |
| `bully_flag` | `BADGE with a thick vivid rim #86322D and a field of light warm red #CA6660. Cap dyed deeper red #A8504E. Alarmed wide-open eyes, mouth open mid-bark, holding up a WHITE pennant beside the muzzle: a clear TRIANGLE of white cloth on a short white pole, pointing away from him, about a third of the diameter of the badge. It is a triangular signal flag, NOT a rectangle, NOT a square, NOT a sheet of paper, NOT a napkin.` |
| `bully_warn` | `BADGE with a thick vivid rim #AD6B25 and a field of light amber #DDA060. Cap dyed deeper amber #C28B48. Worried expression, mouth a flat tense line, both ears still big and upright. A big flat WHITE warning triangle with a bold dark exclamation mark inside it beside the muzzle, at least half the diameter of the badge.` |
| `bully_lock` | `BADGE with a thick vivid rim #395B7A and a field of soft denim blue #6690B5. Cap dyed deeper slate blue #6A7A8C. Holding a big closed flat WHITE padlock, at least half the diameter of the badge, up just under the chin in both front paws, stern serious expression, one eyebrow raised.` |
| `bully_expert` | `BADGE with a thick vivid rim #395B7A and a field of soft denim blue #6690B5. Cap dyed deeper slate blue #6A7A8C. Head turned slightly to one side, one front paw raised pointing off to that side, a big bold flat WHITE arrow beside the muzzle pointing the same way, at least half the diameter of the badge.` |

Цвета не словами, а числом. Прогон 04.09 показал, зачем: на `GREEN`, `RED`
и `AMBER-YELLOW` модель отвечает болотным, кирпичным и горчичным — каждый раз
своим. Шестнадцатеричные коды замерены **по эталонному прогону 06.09**, тому
самому, который приняли: это не пожелание, а его же цвета, названные точно.

**Плашка — три зоны, и главная из них рамка.** Замер по оригиналу
`bully_done`, кольцами от центра к краю:

| зона | радиус | цвет | яркость | насыщенность |
|---|---|---|---|---|
| центр за мордой | 0.55–0.75 | `#737E71` | 120 | 13 |
| поле | 0.80–0.90 | `#95A67A` | 156 | 44 |
| **рамка** | 0.93–1.00 | `#40814C` | 104 | **65** |

Рамка темнее поля на 52 единицы яркости и насыщеннее его в полтора раза,
толщиной примерно в одну двадцатую диаметра. Она и делает иконку иконкой:
цвет считывается с краешка, а к центру гаснет, чтобы не спорить с самой
бульдожкой.

| роль | рамка | поле | кепка |
|---|---|---|---|
| ок | `#40814C` | `#95A67A` | `#698265` |
| с оговорками | `#AD6B25` | `#DDA060` | `#C28B48` |
| не ок | `#86322D` | `#CA6660` | `#A8504E` |
| просто работа | `#395B7A` | `#6690B5` | `#6A7A8C` |
| непонятно | `#4F7090` | `#8DA3B8` | `#808790` |

Зелёная рамка замерена с оригинала, остальные четыре выведены в том же
контрасте к своему полю. Кепка темнее поля на 17–29 единиц: так у оригинала,
и это обратно плану из `prompt-pack-v2.md`, где диск был тёмным, а кепка
светлой.

**Два прогона палитры мимо, и оба — от того, что я мерил не ту величину.**
Сначала поставил тёмную насыщенную: по замерам она выигрывала, владелец
забраковал с одного взгляда — «потеряла лёгкость». Потом взял светлую,
но замерил только СРЕДНЮЮ яркость поля, а не профиль по радиусу, — и получил
поле насыщенностью 32 вместо 44 и рамку с перепадом 8 вместо 52. Формально
«светлая, как эталон», на деле бледная размазня. Мерить надо профиль,
а не одно число: у иконки цвет живёт в перепаде от края к центру.

Предмет во всех семи ячейках белый. Не потому, что так красивее: замок был
золотой, треугольник жёлтый, флажок красный, стрелка жёлтая — и на 21 px
золото на синем, жёлтое на янтарном и красное на красном пропадали вовсе.
Белое читается на всех пяти цветах плашки одинаково, а «не своего» цвета
предмет тут и не бывает: это пиктограмма, а не вещь.

## Что пришло с прогона 2026-09-04 (`out-each/`, ещё без плашки)

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

## Что пришло с прогона 2026-09-06 (`out-badge/`, первый с плашкой)

Шестнадцать прогонов Nano Banana Pro, первый — `bully_helpful` без якоря,
остальные пятнадцать с ним третьим референсом. Формат выдержан: все
шестнадцать — PNG 128×128 с альфой по 17–34 КБ, тринадцать с плашкой,
три лапой, состав пака полный. Дальше — то, ради чего затевался разбор:
владелец посмотрел пак и сказал, что персонажи «немножко разные».

Разные. Пять расхождений, и три из них промпт просил сам.

1. **Четыре собаки из шестнадцати — другой породы.** У `bully_fail`,
   `bully_none` и `bully_warn` уши висят вдоль щёк, у `bully_mid` одно ухо
   стоит, другое висит. Это не сбой модели: подстановки требовали
   `ears drooping down`, `ears drooping flat`, `ears back`, `one ear up and
   one ear half down`. У французского бульдога стоячие уши и есть силуэт —
   с висячими выходит гончая. Разбор и правило — в разделе про мимику.

2. **Морда мельче плашки у десяти иконок из тринадцати.** Эталон
   `bully_done`: козырёк от ободка до ободка, уши обрезаны ободком, глаза
   на оси круга. `bully_ready`, `bully_hi`, `bully_search`, `bully_unknown`,
   `bully_expert`, `bully_high`: голова примерно в две трети диаметра,
   сверху широкое поле пустой заливки. На плашке реакции это и читается
   «мелкая собачка на кружке» вместо «крупный бульдожка».

   Причина — в шаблоне: он требовал, чтобы персонаж целиком помещался
   внутрь круга с полями и ободком не резался. `bully_done` вышел хорошим
   ровно потому, что модель эту фразу нарушила. Правило переписано под
   эталон и задано числом.

3. **Лапы разъехались втроём.** `bully_detail` пришёл человеческой кистью
   с пальцами, суставами и ручкой в щепоти; у `bully_helpful`
   и `bully_not_helpful` лапа вышла безволосой бежевой культёй,
   а предплечье — во весь кадр, у одной от левого края, у `bully_detail`
   от правого. Три кнопки в ряд выглядят как из разных наборов. Разбор —
   в разделе про лапу.

4. **Цвет просили словом, и он приглушился.** На `BADGE amber-yellow`
   и `BADGE red` пришли близкие тёплые светлые тона: на 21 px разница между
   `bully_mid` и `bully_none` — 21.8 при пороге различимости 22, то есть
   их нет. А это две соседние лампочки одного светофора в шапке ответа —
   единственная пара пака, которая сталкивается в одном месте интерфейса.
   Подстановки переведены на шестнадцатеричные коды.

5. **Предметы цветные и мелкие — на плашке реакции их нет.** Золотой замок
   на синем, жёлтая стрелка на синем, красный флажок на красном, лупа
   в пол-морды: всё это видно на 128 px и исчезает на 21. Предмет теперь
   белый и не меньше половины диаметра плашки.

Ещё два замечания, оба мелкие:

* **`bully_fail`: плашка 117 px при 123 px у остальных** — на плашке реакции
  читается как иконка чуть меньше соседних.
* **`bully_unknown`: 6 % непрозрачного — нейтрально-серое.** Сине-серая
  плашка держится у самой границы того, что `sheet.key_background` снимает
  как фон. В этот раз обошлось; правило «разброс каналов не меньше 30»
  остаётся обязательным, `#4F5A6E` даёт ровно 31.

**Перегенерировать надо все шестнадцать.** Правка про кадр меняет каждую
из тринадцати иконок с плашкой, правка про белый предмет — семь, правка
про уши — четыре, палитра — все. Точечно чинится один файл, а не пак,
и пак после этого перестаёт быть одним паком: ровно так и получилось,
что в репозитории лежат три папки с тремя дизайнами.

**Смотреть результат — `check_pack.py`, до заливки.** Он ловит числом
состав, формат, отсутствующую плашку (то есть иконку из другого прогона),
выпавшую по размеру плашку, срез по краю, остатки фона и неразличимые
на 21 px пары; контактные листы `--sheets` показывают то, что числом
не берётся, — персонажа, уши и крупность морды.

## Что пришло с прогона 2026-09-07 (откачен)

Прогон по исправленному промпту дал четырнадцать иконок из шестнадцати
(на двух кончились кредиты) — и **владелец забраковал их все**: «бледная
херня», «некрасивые». Пак откачен к прогону 06.09, картинки остались
в истории git.

По персонажу прогон был лучше: уши стоячие во всех, разброс крупности
головы 0.32 → 0.23, лапа перестала быть человеческой кистью. По виду —
хуже, и вот чем.

**Первое: я мерил не ту величину.** Замерил среднюю яркость поля плашки,
получил 163 при эталонных 148 и решил, что тон совпал. А цвет иконки живёт
не в средней яркости, а в ПРОФИЛЕ от края к центру. Замер профиля
оригинала — в разделе про палитру: рамка `#40814C` насыщенностью 65, поле
`#95A67A` насыщенностью 44, центр почти серый. У моего было поле
насыщенностью 32 и рамка с перепадом 8 единиц вместо 52. Формально
«светлый, как эталон» — на деле выцветший круг без края.

**Второе, и оно важнее: рядом всё это время лежала принятая иконка,
а я описывал её словами.** Якорь подавался модели с оговоркой
`Ignore its pose, its crop and its background` — то есть как образец одной
фактуры; плашку, кадр и позу задание задавало заново текстом. Отсюда все
метания: три захода на палитру, два на кадр, и каждый раз новая клауза
про плашку сдвигала кадр, потому что подстановка короткая и вес в ней
делится. Поза при этом уехала тоже — бульдожка вышел суше и тоньше того,
что приняли.

Оговорка снята (`ANCHOR_NOTE` в `generate.py`): с якоря теперь копируется
всё — поза, кадр, плашка с её рамкой и переходом тонов, — а подстановка
меняет только цвет, выражение и предмет. **Правило: если принятая картинка
есть, она главнее любого описания словами.** Описание остаётся на случай,
когда якоря нет вовсе.

**Что делать дальше.** Пополнить кредиты и прогнать пятнадцать иконок
(все, кроме `bully_done` — он принят и не трогается) с ним в якоре;
команды — в разделе «Прогон».

## Прогон

Якорь — **эталон пака**, а не первая попавшаяся иконка прогона: он один
показывает и персонажа, и кадр в плашке. Для лап якорь свой: морда в якоре
протаскивает в кадр кепку с ушами, хотя клауза их запрещает.

**`bully_done` не перегенерируется.** Он принят, лежит в `out-badge/`
и служит якорем всему остальному. Перекатывать его — терять то, к чему
пак и сводят: у прогонов 06–07.09 на это ушло пять попыток и ни одна
не догнала оригинал.

```
# 1. двенадцать иконок с плашкой, принятый bully_done третьим референсом
python3 generate.py prompt-each.md --each --anchor out-badge/bully_done.png \
    --only bully_ready,bully_fail,bully_hi,bully_search,bully_high,bully_mid,bully_none,bully_unknown,bully_flag,bully_warn,bully_lock,bully_expert \
    --out raw-badge/ --force

# 2. эталон лапы: одна и без якоря-морды — морда протащит в кадр кепку с ушами
python3 generate.py prompt-each.md --each --only bully_helpful --out raw-badge/ --force

# 3. две оставшиеся лапы, якорь — принятая лапа
python3 generate.py prompt-each.md --each --anchor raw-badge/bully_helpful.png \
    --only bully_not_helpful,bully_detail --out raw-badge/ --force

# нарезка каждой в 128x128 с прозрачным фоном
for f in raw-badge/*.png; do n=$(basename "$f" .png); \
    python3 slice_grid.py "$f" --cols 1 --rows 1 --names "$n" --out out-badge/; done
# bully_done не режется заново: он уже лежит в out-badge/ принятым

# проверка до заливки: числом — формат и разъезд, глазами — контактные листы
python3 check_pack.py out-badge --sheets review/
```

Готовые файлы `--each` не перегенерирует: прогон стоит денег, и повтор всей
пачки ради одной неудачной иконки — ровно то, от чего уходили с листа. Чтобы
перекатить одну, зовут с `--only <имя> --force`.

**Именно `--force`, а не удаление файла.** `run()` пишет картинку только после
того, как она пришла, поэтому оборвавшийся прогон оставляет старую на месте,
а удаление — нет. Прогон 07.09: удалили `bully_unknown`, чтобы сделать плашку
синее, и на этой же команде кончились предоплаченные кредиты. Иконка была
годная, замены не пришло, в паке осталась дыра.

**Но перекатывать по одной можно только пока правка местная.** Правка
в шаблоне — кадр, уши, цвет предмета — меняет все шестнадцать, и пак после
починки одной иконки перестаёт быть одним паком. Так и вышло: в репозитории
три папки с тремя дизайнами. Правка в шаблоне — прогон целиком, `--force`
или пустая папка.
