import torch
from torch import nn


class TinyNet(nn.Module):
    def __init__(self, width: int = 128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(784, width),
            nn.ReLU(),
            nn.Linear(width, 10),
        )

    def forward(self, x):
        return self.net(x.flatten(1))
