# D&H College SAT Practice Portal 

## How the modes work

- English Only uses all detected modules where the section is `Reading and Writing`.
- Math Only uses all detected modules where the section is `Math`.
- Full Test uses every detected module.

## How to open

For best results, run a local server:

```bash
cd dh-sat-practice-three-modes
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Admin account

Create an account and check:

```text
Create as admin account
```

Use:

```text
DNH-SAT-ADMIN
```

Change this inside `app.js` before sharing.

## Answer key CSV

Use this format:

```csv
module,question,section,correct_answer,type
RW1,1,Reading and Writing,A,multiple_choice
RW1,2,Reading and Writing,C,multiple_choice
RW2,1,Reading and Writing,D,multiple_choice
M1,1,Math,12,grid_in
M1,2,Math,B,multiple_choice
```

The `module` must match the detected module key:
- RW1
- RW2
- M1
- M2

## Optional scoring CSV

```csv
section,raw_score,scaled_score
Reading and Writing,43,640
Math,35,650
```

If no scoring table is uploaded, the app estimates the section score from 200 to 800 based on percentage correct.

## Data storage

This is a browser-based local app. It stores PDFs and test data in IndexedDB and localStorage. Clearing browser site data can delete uploaded tests.
