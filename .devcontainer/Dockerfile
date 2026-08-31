FROM mcr.microsoft.com/devcontainers/base:debian

ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Drop unused zsh/oh-my-zsh, free ~15MB
RUN rm -rf /home/*/.oh-my-zsh /root/.oh-my-zsh \
    && apt-get update \
    && apt-get purge -y zsh \
    && apt-get autoremove -y

# Tools for managing the remote kytrack Pi (APRS / dxlAPRS gateway)
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-client \
        sshpass \
        rsync \
        mosquitto-clients \
        curl \
        jq \
        netcat-openbsd \
        iputils-ping \
        less \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Base image ships a 'vscode' user at UID 1000; rename it to 'dev' (keeps UID 1000)
RUN usermod -l dev -d /home/dev -m vscode \
    && groupmod -n dev vscode \
    && sed -i 's/vscode/dev/g' /etc/sudoers.d/vscode || true \
    && mv /etc/sudoers.d/vscode /etc/sudoers.d/dev 2>/dev/null || true

WORKDIR /workspaces/kytrack
RUN echo 'cd /workspaces/kytrack 2>/dev/null' >> /home/dev/.bashrc

# Per-user npm prefix on PATH so claude (installed into ~/.npm-global/bin by
# postCreate) resolves. Set as image ENV, not appended
# to .bashrc: Debian's .bashrc returns early for non-interactive shells, so a
# PATH export there is invisible to `ssh <host> claude ...`, cron and scripts.
# ENV applies to every shell, interactive or not.
ENV PATH="/home/dev/.npm-global/bin:${PATH}"

# Force UTF-8 locale so tmux renders Unicode block glyphs (claude's splash logo)
# correctly. Must also come before the tmux guard.
RUN echo 'export LANG=C.UTF-8' >> /home/dev/.bashrc

# Persistent claude session: interactive SSH logins auto-attach a tmux session
# "main" running claude, so it survives disconnects (reconnect = continue).
RUN printf '%s\n' \
    '' \
    '# --- Persistent claude session (auto-attach tmux on interactive SSH) ---' \
    'if [ -n "$SSH_CONNECTION" ] && [ -z "$TMUX" ] && [ "$TERM_PROGRAM" != "vscode" ] && [ ! -f "$HOME/.no-tmux" ] && command -v tmux >/dev/null 2>&1; then' \
    '    case "$-" in' \
    '        *i*) exec tmux new-session -A -s main -c /workspaces/kytrack "claude; exec bash" ;;' \
    '    esac' \
    'fi' \
    >> /home/dev/.bashrc
