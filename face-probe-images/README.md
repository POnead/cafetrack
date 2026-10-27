# face-probe-images/

Photographs for `npm run probe:face`. **Git-ignored** — these are real faces.

One folder per person, with two or more photographs of each:

```
face-probe-images/
  ana/
    front.jpg
    left.jpg
    right.jpg
    window-light.jpg
  ben/
    phone.jpg
    evening.jpg
  chidi/
    front.jpg
    turned.jpg
```

The folder name is only a label. What matters:

- **at least three people, ideally eight or more** — the closest impostor pair is
  the number the threshold has to clear;
- **at least two photographs of each person, taken at different times** — the
  worst genuine pair is the other side of the same decision;
- **vary the light, the distance and the angle** within each person. Five
  identical studio portraits will produce a beautiful separation that says
  nothing about a cafe counter at 7am;
- **one face per photograph**, reasonably large in frame. This measures the
  reader, not the detector's ability to find a face in a crowd.

Then, with the dev server running:

```
npm run dev
npm run probe:face
```

Output goes to `.cache/face-probe/`: `results.json` plus annotated frames with
the detection box and five landmarks drawn on, so "it found the right face" can
be checked by eye instead of trusted.
