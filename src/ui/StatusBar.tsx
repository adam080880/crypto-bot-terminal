import React from "react";
import { Box, Text } from "ink";

interface Props {
  depth: number;
  tickSize: number;
}

export function StatusBar({ depth, tickSize }: Props) {
  const fmtTick = tickSize < 1 ? tickSize.toString() : tickSize.toLocaleString("en-US");
  return (
    <Box paddingX={1} marginTop={1} gap={3}>
      <Text color="gray" dimColor>[<Text color="white">+/-</Text>] depth:<Text color="cyan"> {depth}</Text></Text>
      <Text color="gray" dimColor>[<Text color="white">[]</Text>] tick:<Text color="cyan"> {fmtTick}</Text></Text>
      <Text color="gray" dimColor>[<Text color="white">Tab</Text>] view</Text>
      <Text color="gray" dimColor>[<Text color="white">/</Text>] symbol</Text>
      <Text color="gray" dimColor>[<Text color="white">q</Text>] quit</Text>
    </Box>
  );
}
