PROYECTO: PaginaVentasRojas (Netlify + GitHub db.json)

1) SUBE ESTE PROYECTO A TU REPO DE GITHUB.
   - Base de datos: data/db.json

2) EN NETLIFY (Site settings -> Environment variables) agrega:
   GITHUB_TOKEN      = (tu token real)
   GITHUB_REPO       = TU_USUARIO/TU_REPO   (ej: virtualformacion/steenbeat)
   GITHUB_FILE_PATH  = data/db.json
   GITHUB_BRANCH     = main

3) DEPLOY EN NETLIFY:
   - Netlify detecta netlify.toml
   - Publica carpeta: public/
   - Functions carpeta: functions/

4) ENDPOINT:
   /.netlify/functions/db

5) LOGIN:
   Admin: admin / 2026clave   (vence: 2027-01-01)
   Usuario demo: cliente1 / 1234

IMAGENES:
   Coloca tus imagenes en public/ con estos nombres:
   logo.jpg, fondo.jpg, netflix.jpg, disney.jpg, prime.jpg
