# Cameras for your tables: how to set up

The cameras tell the counter which tables are free, taken or waiting to be cleaned. They see people, not faces: no picture leaves the shop PC, and nothing is recorded.

## 1. Where to put a camera

- High in a corner, looking down at the seats, so a person sitting at a table is clearly inside it.
- Every chair in view. A table half hidden behind a pillar or a fridge is guessed wrong.
- Not facing a window or the door: bright light behind people makes them hard to see.
- One camera can watch several tables. Up to 4 cameras can be used at once.
- Wi-Fi or cable both work. The camera must be on the same network as the shop PC.

## 2. Turn on ONVIF and RTSP on a Tiandy camera

The shop PC talks to the camera over ONVIF (to find it and ask for its video) and RTSP (the video itself). On a Tiandy camera both are usually set on the camera's own web page, under its network settings.

- Open the camera's web page from a browser on the shop PC (type the camera's address), and log in with the camera's own username and password.
- Find ONVIF and RTSP and turn both on. If ONVIF asks for its own user, make one there.
- The menus differ between models and firmware: if you cannot find them, check Tiandy's manual for your model.
- You do not need to know the video's path: setup asks the camera for it ("Ask the camera").

A dual-lens camera gives two views, one for each lens. Each view is set up like its own camera, with its own tables.

## 3. Switch it on and find the cameras

- On the shop PC, Manager mode (Ctrl+M), then Ctrl+K and Cameras. It asks for your owner's PIN.
- Press Activate CV. The first time, the shop PC downloads the camera pack; this takes a few minutes.
- Scan for cameras finds the cameras on the shop's network. Pick one, then Ask the camera for its views.
- Type the camera's username and password on the shop PC only. They stay on that PC and are never sent anywhere, not even to your phone. Nobody, including support, should ask you for them.
- Test shows a still from the camera. Turn "Use for CV" on for the cameras you want.

## 4. Tables and zones

- Add your tables with their numbers and seats, as the staff call them.
- For each camera, draw a zone around each table it sees: click the corners around the table and its chairs, then Enter, then pick the table. Include where people sit, not the walkway.

## 5. The three timers

Someone at a table makes it occupied at once. After that:

- A visit shorter than this needs no cleaning (3 min): someone who only stood there, or a waiter. The table goes straight back to free.
- Empty this long counts as left (10 s): one missed glimpse does not end a visit.
- Free again by itself after (5 min): a table waiting to be cleaned turns free on its own. Staff can free it sooner from the floor (F1, then C).

When a table needs cleaning, the counter shows "Table N needs cleaning" for 5 seconds, and the Tables key turns red until it is clean.

## 6. A Shadow week, then Live

- Start in Shadow. The cameras watch and the staff run the floor as usual, so nothing changes for them.
- After a week, the Owner view says how often the cameras agreed with the staff. From 85% it offers to switch to Live; below that, it lists the misses so you can fix the zones.
- In Live the cameras set the floor. Staff can still change any table, with Undo.
- Off stops the cameras completely.

## 7. The CPU limit

The cameras share the shop PC with the register. The CPU limit (15% to start) is how much of the PC they may use; they look less often to stay under it. Raise it only if the tables lag behind, and never so far that the register slows down.

## When a camera is offline

Its tables keep their last state and say "no camera" until it is back. Check its power and Wi-Fi.
