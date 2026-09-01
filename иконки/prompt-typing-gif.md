# Задание Nano Banana: анимация «булли печатает»

Один лист 3×3 = девять кадров цикла. Приложить `bulli-ref.png`, просить
**PNG в максимальном разрешении**.

Ключевое требование здесь одно и оно не про содержание, а про камеру:
**кадры обязаны совпадать пиксель в пиксель везде, кроме движущихся лап.**
Модель по умолчанию слегка меняет ракурс и масштаб от ячейки к ячейке —
на статичном паке это незаметно, а в GIF превращается в дрожание, из-за
которого анимацию невозможно смотреть. Поэтому запрет на смещение камеры
повторён в промпте трижды и вынесен отдельным абзацем капслоком.

Второе решение — **клавиатура целиком внутри ячейки**, а не обрезана нижним
краем. Обрезанная выглядит естественнее, но тогда у силуэта нет замкнутого
контура: die-cut обводка не строится, фон вырезается с рваным низом, и в
Mattermost эмодзи получает серую полосу под лапами.

```
Use the attached image as the exact character reference. The SAME character in
every frame: a 3D Pixar-style cartoon French bulldog, cream and tan fur, big
glossy brown eyes, dark brown nose, freckled muzzle, oversized upright ears,
wearing a worn blue denim baseball cap with the white embroidered word "CROSS"
on the front panel.

Output ONE single square image, 1:1 aspect ratio, at the highest resolution
available.

This image is a 9-frame animation sprite sheet: a strict 3 x 3 grid, frames read
left to right, top to bottom, frame 1 to frame 9. Nine equal square cells, equal
outer margins, a uniform gap between cells. No cell borders, no frames, no grid
lines, no frame numbers, no captions, no labels, no watermark. The ONLY text
anywhere in the whole image is the word "CROSS" on the cap.

BACKGROUND: one flat uniform medium grey (#808080) filling the entire canvas
including the gaps between the cells. No gradient, no vignette, no ground
shadow, no reflections.

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

Both the dog and the keyboard together share one clean, even white die-cut
sticker outline about 8 pixels thick around the whole combined silhouette.

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
- **лапы реально в разных положениях.** Модель иногда отдаёт девять почти
  одинаковых кадров — тогда GIF выйдет статичным, и это видно только
  собрав его;
- **кадр 5 с закрытыми глазами ровно один.** Два моргания подряд читаются
  как подёргивание.

Сборка: `python3 make_gif.py typing-sheet.png --out out/bulli_typing.gif --ms 80`.
Девять кадров по 80 мс = цикл 0.72 с — темп «быстро печатает». Медленнее
120 мс выглядит уже как «тыкает одним пальцем».
