/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "../shared-ui/**/*.{erb,html}",
    "./views/**/*.{erb,html}",
    "./public/**/*.{html,js}",
  ],
  theme: {
    extend: {
      colors: {
        seqblue: "#1B557A",
        seqorange: "#C74F13",

        // Measured from alliancegenome.org on 2026-09-30, so the BLAST chrome
        // matches the rest of the site rather than approximating it.
        alliance: "#2598C5",
        // Not on their site: a darkened step for hover and for link text on a
        // white ground, where #2598C5 alone is thin against body copy.
        alliancedeep: "#1B7FA6",
        // Their Bootstrap neutral ramp, used for chrome only.
        agrink: "#212529",
        agrink2: "#495057",
        agrmute: "#6C757D",
        agrline: "#DEE2E6",
        agrwash: "#F8F9FA",
      },
      fontFamily: {
        // Their body face. Kept as an explicit family rather than replacing
        // the base sans, so only the chrome opts into it.
        alliance: ['Lato', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
      }
    },
  },
  plugins: [],
};