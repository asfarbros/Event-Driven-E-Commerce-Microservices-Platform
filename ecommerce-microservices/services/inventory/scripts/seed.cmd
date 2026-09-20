@echo off
rem Windows twin of seed.sh: seed inventory rows for every Catalog product (explicit, never on boot).
rem   scripts\seed.cmd            insert missing rows only
rem   scripts\seed.cmd --update   also reset existing rows to the seed quantity
setlocal
cd /d "%~dp0.."
if not exist target\inventory-service.jar (
  echo ^>^>^> [seed] building target\inventory-service.jar
  call mvnw.cmd -q -B -DskipTests package || exit /b 1
)
java -jar target\inventory-service.jar --spring.profiles.active=seed %*
