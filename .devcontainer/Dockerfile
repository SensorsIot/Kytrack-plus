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
