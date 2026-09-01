# Задание Nano Banana: анимация «булли печатает»

Один лист 3×3 = девять кадров цикла. Приложить `bulli-ref.png`, просить
**PNG в максимальном разрешении**.

**Здесь лист обязателен, в отличие от стикеров.** Кадры цикла должны совпадать
пиксель в пиксель по камере, а девять отдельных прогонов дадут девять слегка
разных ракурсов — собрать из них GIF нельзя вообще. Значит риск сноса стиля,
который на стикерах лечится поштучной генерацией, здесь приходится сбивать
только формулировками.

Поэтому в промпте два независимых запрета, и путать их не надо:

| | что запрещает |
|---|---|
| `THE CAMERA IS LOCKED` | смещение ракурса и масштаба между кадрами — иначе GIF дрожит |
| `Do NOT redraw him` | подмену 3D-рендера плоским рисунком — на этом сломалась первая пачка стикеров |

Слова `sticker` в промпте нет намеренно: на стикерах оно вытянуло бумажную
фактуру и плоскую заливку. Белой обводки тоже нет — прогон показал, что серый
фон снимается с кремовой шерсти без неё и без каймы на тёмной теме.

Клавиатура при этом **целиком внутри ячейки**, а не обрезана нижним краем:
обрезанная выглядит естественнее, но у силуэта тогда нет замкнутого контура,
и вырезание фона оставит серую полосу под лапами.

```
This is the same character as in the attached image, in every frame. Keep him
EXACTLY as he is: the same 3D render, the same soft studio lighting, the same
fur shading and texture, the same huge glossy dark-brown eyes with the same
white highlights, the same freckled muzzle, the same big upright ears, the same
worn blue denim baseball cap with the white embroidered word "CROSS".

Do NOT redraw him. Do NOT restyle him. Do NOT turn him into a 2D illustration,
a painted cartoon, a vector drawing or a printed sticker. No paper texture, no
canvas texture, no glossy print finish, no outline drawing, no flat shading. He
must look like the exact same 3D render as the attached image in every frame.

Keep the close-up framing of the attached image: seen from the front at eye
level, the head large in the cell and the eyes the same huge size. Do NOT zoom
out to a full body and do NOT make the head smaller.

Output ONE single square image, 1:1 aspect ratio, at the highest resolution
available.

This image is a 9-frame animation sprite sheet: a strict 3 x 3 grid, frames read
left to right, top to bottom, frame 1 to frame 9. Nine equal square cells, equal
outer margins, a uniform gap between cells. No cell borders, no frames, no grid
lines, no frame numbers, no captions, no labels, no watermark. The ONLY text
anywhere in the whole image is the word "CROSS" on the cap.

BACKGROUND: one flat uniform medium grey (#808080) filling the entire canvas
including the gaps between the cells. No gradient, no vignette, no ground
shadow, no reflections. Leave a clear empty margin of background around the
character inside every cell: neither the dog, nor his ears or raised paws, nor
the keyboard may touch or run off the edges of their cell, in any frame.

THE CAMERA IS LOCKED. THIS IS THE MOST IMPORTANT RULE. Across all nine frames
the framing, the crop, the camera distance, the camera angle, the lighting and
the character's position within the cell are identical, pixel for pixel. The
body, the head, the cap and the keyboard occupy exactly the same place at
exactly the same size in every single frame. Nothing drifts, nothing zooms,
nothing rotates, nothing is re-framed. ONLY the parts listed frame by frame
below are allowed to change.

THE SCENE, identical in every frame: the bulldog is seen from the front, sitting
behind a large simple light grey computer keyboard that lies flat in front of
him, fully inside the cell and not touching any cell edge. His head, cap, chest
and both front paws are visible above the keyboard, and both front paws rest on
the keys. The keyboard is big, plain and low detail so that it stays readable at
128 x 128 pixels: plain blank keycaps with no letters on them.

THE ANIMATION is a fast, energetic, seamless typing loop: the dog hammers the
keyboard with both front paws, busy and focused, with a happy determined
expression. Frame 9 must flow straight back into frame 1 with no jump.

Frame by frame, ONLY these things change:

1. Both paws pressed down on the keys, head level, eyes open looking forward.
2. Left paw lifted high in the air, right paw down on the keys, head tipped
   slightly down.
3. Left paw slamming down onto the keys with a small white impact puff, right
   paw starting to lift, ears bounced upward.
4. Right paw lifted high in the air, left paw down on the keys, head level.
5. Right paw slamming down with a small white impact puff, left paw starting to
   lift, eyes closed in a blink.
6. Left paw lifted high in the air, right paw down, eyes open again, ears
   bounced upward.
7. Left paw slamming down with a small white impact puff, right paw lifted
   halfway.
8. Right paw lifted high in the air, left paw down, head tipped slightly down.
9. Both paws halfway down, moving back toward the frame 1 position, head
   returning to level.

Keep the motion large and readable: the paw lift is a big obvious movement,
while the head bob and the ear bounce stay small. Do not add motion blur
streaks, speed lines, sweat drops, floating musical notes or any extra objects
apart from the small white impact puffs.
```

## Что проверить до сборки GIF

- **клавиатура на одном и том же месте во всех девяти ячейках.** Уехала
  хотя бы в одной — этот кадр в цикле будет дёргаться, и вылечить его
  нарезкой нельзя, только перегенерацией листа;
- **надпись CROSS на месте во всех девяти;**
- **глаза того же размера, что в референсе, и рендер объёмный.** Если пришёл
  плоский рисунок с фактурой бумаги — лист переделывать целиком, это тот же
  слом, что на первой пачке стикеров;
- **лапы реально в разных положениях.** Модель иногда отдаёт девять почти
  одинаковых кадров — тогда GIF выйдет статичным, и это видно только
  собрав его;
- **кадр 5 с закрытыми глазами ровно один.** Два моргания подряд читаются
  как подёргивание.

Сборка: `python3 make_gif.py typing-sheet.png --out out/bulli_typing.gif --ms 80`.
Девять кадров по 80 мс = цикл 0.72 с — темп «быстро печатает». Медленнее
120 мс выглядит уже как «тыкает одним пальцем».
