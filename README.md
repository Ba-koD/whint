# Whint

Wordle board states into precise candidate filtering and next-word recommendations.

## Local

```bash
npm install
npm run dev
```

The dev/build scripts generate `public/words.json` from:

`https://raw.githubusercontent.com/tabatkins/wordle-list/main/words`

That list is MIT licensed and is treated as a pinned allowed-guess list at build time. It is not an official New York Times API or an officially guaranteed Wordle answer list.

## Deploy

1. Push to `main`.
2. In the GitHub repository, set Pages source to `GitHub Actions`.
3. Set the Pages custom domain to `whint.rnen.kr` and enable HTTPS after GitHub provisions the certificate.
4. The workflow in `.github/workflows/pages.yml` builds the app and deploys `dist/`.

`public/CNAME` is included for branch-style Pages compatibility and static artifact clarity. For GitHub Actions Pages, GitHub stores the actual custom domain in repository Pages settings; the DNS for `whint.rnen.kr` should be a CNAME to the repository owner Pages domain, currently `ba-kod.github.io`.

## Checks

```bash
npm run build
npm audit --omit=dev
```
