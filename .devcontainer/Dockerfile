FROM mcr.microsoft.com/devcontainers/base:bookworm

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

# Base image ships a 'vscode' user at UID 1000; rename it to 'dev' (idempotent if already done)
RUN if id -u dev >/dev/null 2>&1; then \
        true; \
    elif id -u vscode >/dev/null 2>&1; then \
        groupmod -n dev vscode && \
        usermod  -l dev -d /home/dev -m -s /bin/bash vscode && \
        sed -i 's/^vscode /dev /' /etc/sudoers.d/* 2>/dev/null || true; \
    else \
        groupadd --gid $USER_GID dev && \
        useradd --uid $USER_UID --gid $USER_GID -m -s /bin/bash dev; \
    fi

WORKDIR /workspaces/kytrack
RUN echo 'cd /workspaces/kytrack 2>/dev/null' >> /home/dev/.bashrc
