# Inpact tournées

Ce projet transforme des fiches de rotation de bacs PAV (points d'apport volontaire), en PDF ou en photo, en une tournée de camion optimisée. Le camion part du dépôt et y revient, sans allers-retours inutiles.

## Utilisation depuis le téléphone (skill Claude)

1. Installe le skill `skill/tournee-pav/SKILL.md` dans Claude. Il faut que l'exécution de code soit activée.
2. Dans le skill, renseigne la ligne **Dépôt par défaut**. Sinon, Claude te demandera l'adresse du dépôt à chaque fois.
3. Envoie tes fiches (PDF ou photos) à Claude et demande « fais-moi la tournée ».
4. Claude te renvoie un fichier Excel avec :
   - **Tournée** : les arrêts dans l'ordre, avec les bacs, les remarques, les km et un lien Google Maps par point ;
   - **Itinéraire** : les liens Google Maps du trajet, par tronçons de 8 arrêts ;
   - **À vérifier** : les adresses introuvables ou situées loin du dépôt.

Si Claude affiche « Service d'adresses injoignable », il faut autoriser les domaines `data.geopf.fr` et `api-adresse.data.gouv.fr` dans les réglages d'accès réseau de l'exécution de code.

## Ce qui fait quoi

| Étape | Outil | Clé API |
|---|---|---|
| Texte des PDF | [pdfplumber](https://github.com/jsvine/pdfplumber) (open source) | non |
| Photos et scans | lecture par Claude | non |
| Adresse → GPS | [Base Adresse Nationale](https://adresse.data.gouv.fr) (service public) | non |
| Ordre de passage | [OR-Tools](https://github.com/google/or-tools) (voyageur de commerce, open source). Si OR-Tools n'est pas installable, une heuristique plus proche voisin + 2-opt prend le relais. | non |
| Fichier Excel | [openpyxl](https://openpyxl.readthedocs.io) (open source) | non |

Les distances sont estimées à vol d'oiseau × 1,3.

## Utilisation en ligne de commande

```bash
pip install ortools openpyxl
python3 skill/tournee-pav/tournee.py points.csv --depot "12 rue X, 35000 Rennes" -o tournee.xlsx
```

Le format attendu est dans `tests/exemple_points.csv` (séparateur `;`).

## Test

```bash
python3 tests/test_tournee.py
```

Ce test simule le service d'adresses en local : il n'a pas besoin d'Internet.

## Autres fichiers

- `web/tournee-pav.html` : la première version sous forme de page web (Claude Artifact). Elle fait la même chose avec une carte, mais estime les positions GPS sans la Base Adresse Nationale.
