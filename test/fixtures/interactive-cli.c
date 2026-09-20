// Native PTY fixture, compiled as codex/claude for herdr integration tests.
// No AI requests. Report lifecycle only for this fixture's inherited pane.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <termios.h>
#include <sys/wait.h>
static const char *tool;
static void report(const char *state) {
  pid_t pid = fork();
  if (!pid) {
    execlp("herdr", "herdr", "pane", "report-agent", getenv("HERDR_PANE_ID"), "--source", "work-tree:test", "--agent", tool, "--state", state, (char*)NULL);
    _exit(127);
  }
  waitpid(pid, NULL, 0);
}
int main(int argc, char **argv) {
  tool = strrchr(argv[0], '/'); tool = tool ? tool + 1 : argv[0];
  if (argc == 2 && !strcmp(argv[1], "--version")) { puts("interactive fixture 1.0"); return 0; }
  const char *base = getenv("FAKE_CAPTURE");
  if (!base || !isatty(0)) return 2;
  char file[4096]; snprintf(file, sizeof(file), "%s.args", base);
  FILE *out = fopen(file, "w"); if (!out) return 3;
  for (int i = 1; i < argc; i++) fprintf(out, "%s\n", argv[i]); fclose(out);
  struct termios original, raw; tcgetattr(0, &original); raw = original;
  raw.c_lflag &= ~(ICANON | ECHO); raw.c_iflag &= ~(ICRNL); raw.c_cc[VMIN] = 1; raw.c_cc[VTIME] = 0; tcsetattr(0, TCSANOW, &raw);
  printf("\033[?2004hInteractive fixture ready\n"); fflush(stdout); report("idle");
  char buf[262144]; size_t count = 0; int inPaste = 0; char c;
  while (read(0, &c, 1) == 1) {
    if (count + 1 >= sizeof(buf)) return 4;
    buf[count++] = c; buf[count] = 0;
    if (count >= 6 && !memcmp(buf + count - 6, "\033[200~", 6)) { count -= 6; inPaste = 1; continue; }
    if (count >= 6 && !memcmp(buf + count - 6, "\033[201~", 6)) { count -= 6; inPaste = 0; continue; }
    if (!inPaste && (c == '\r' || c == '\n')) {
      buf[--count] = 0;
      if (!count) continue;
      report("working");
      snprintf(file, sizeof(file), "%s.prompt", base); out = fopen(file, "w"); if (!out) return 3; fwrite(buf, 1, count, out); fclose(out);
      printf("\nPrompt received: %s\n", buf); fflush(stdout);
      const char *slow = getenv("FAKE_DELAY"); usleep(slow ? atoi(slow) * 1000 : 800000);
      puts("Fixture result. Continue conversation or confirm in Work Tree."); fflush(stdout); report("idle"); count = 0;
    }
  }
  tcsetattr(0, TCSANOW, &original); return 0;
}
