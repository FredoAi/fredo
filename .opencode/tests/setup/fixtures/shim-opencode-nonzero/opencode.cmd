@echo off
rem QA fixture (issue #3198, AC1 / R-1b): a binary that EXISTS but whose
rem --version fails (no stdout, exit 1). The probe must report "could not
rem determine the version", never "not installed" and never success.
exit /b 1
