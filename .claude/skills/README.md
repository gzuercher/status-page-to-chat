# Skills

Dieser Ordner ist für komplexe, wiederverwendbare Workflows reserviert.

Skills unterscheiden sich von Commands:
- **Commands** = einzelne Dateien, einfache Aufgaben
- **Skills** = Ordner mit SKILL.md + Referenzdokumenten, für mehrstufige Workflows

## Beispiel-Struktur

```
skills/
└── migration-check/
    ├── SKILL.md           # Hauptanweisungen
    └── references/
        ├── patterns.md    # Bekannte Migrations-Patterns
        └── checklist.md   # Prüfliste
```

## Wann einen Skill erstellen?

Wenn ein Workflow:
- Mehrere Schritte hat
- Referenzdokumente braucht
- Von mehreren Teammitgliedern wiederverwendet wird
- Zu komplex für einen einzelnen Command ist
