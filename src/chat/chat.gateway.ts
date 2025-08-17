import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({
  cors: {
    origin: 'http://localhost:3000',
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private connectedUsers = new Map<string, string>(); // userId -> socketId
  private userActiveChats = new Map<string, string>(); // userId -> activeReceiverId
  private activeCalls = new Map<string, any>(); // callId -> call info

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const userId = payload.sub;
      
      // Update user's socket connection
      const oldSocketId = this.connectedUsers.get(userId);
      this.connectedUsers.set(userId, client.id);
      client.join(userId);
      
      // Update active calls with new socket ID
      this.updateUserSocketInActiveCalls(userId, client.id);
      
      await this.sendUnreadCounts(userId);
      console.log(`User ${userId} connected with socket ${client.id}${oldSocketId ? ` (replaced ${oldSocketId})` : ''}`);
    } catch (error) {
      console.log('Unauthorized connection');
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    for (const [userId, socketId] of this.connectedUsers.entries()) {
      if (socketId === client.id) {
        console.log(`User ${userId} disconnected from socket ${client.id}`);
        
        // Give some time for reconnection to avoid ending calls prematurely
        setTimeout(() => {
          const currentSocketId = this.connectedUsers.get(userId);
          if (currentSocketId === client.id) {
            this.connectedUsers.delete(userId);
            this.userActiveChats.delete(userId);
            this.handleUserDisconnectFromCalls(userId);
            console.log(`User ${userId} permanently disconnected after timeout`);
          }
        }, 3000); // Reduced to 3 seconds
        
        break;
      }
    }
  }

  private updateUserSocketInActiveCalls(userId: string, newSocketId: string) {
    for (const [callId, call] of this.activeCalls.entries()) {
      if (call.callerId === userId) {
        call.callerSocketId = newSocketId;
        this.activeCalls.set(callId, call);
        console.log(`Updated caller socket for call ${callId}`);
      } else if (call.receiverId === userId) {
        call.receiverSocketId = newSocketId;
        this.activeCalls.set(callId, call);
        console.log(`Updated receiver socket for call ${callId}`);
      }
    }
  }

  // File Transfer WebRTC Signaling Handlers
  @SubscribeMessage('file_webrtc_offer')
  handleFileWebRTCOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId: string; offer: any },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const senderId = payload.sub;
      
      const targetSocketId = this.connectedUsers.get(data.targetUserId);
      if (targetSocketId) {
        this.server.to(targetSocketId).emit('file_webrtc_offer', {
          userId: senderId,
          offer: data.offer,
        });
        console.log(`File WebRTC offer forwarded from ${senderId} to ${data.targetUserId}`);
      }
    } catch (error) {
      console.error('Error handling file WebRTC offer:', error);
    }
  }

  @SubscribeMessage('file_webrtc_answer')
  handleFileWebRTCAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId: string; answer: any },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const senderId = payload.sub;
      
      const targetSocketId = this.connectedUsers.get(data.targetUserId);
      if (targetSocketId) {
        this.server.to(targetSocketId).emit('file_webrtc_answer', {
          userId: senderId,
          answer: data.answer,
        });
        console.log(`File WebRTC answer forwarded from ${senderId} to ${data.targetUserId}`);
      }
    } catch (error) {
      console.error('Error handling file WebRTC answer:', error);
    }
  }

  @SubscribeMessage('file_webrtc_ice_candidate')
  handleFileWebRTCIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId: string; candidate: any },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const senderId = payload.sub;
      
      const targetSocketId = this.connectedUsers.get(data.targetUserId);
      if (targetSocketId) {
        this.server.to(targetSocketId).emit('file_webrtc_ice_candidate', {
          userId: senderId,
          candidate: data.candidate,
        });
      }
    } catch (error) {
      console.error('Error handling file WebRTC ICE candidate:', error);
    }
  }

  // File Message Handler
  @SubscribeMessage('send_file_message')
  async handleFileMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      receiverId: string; 
      content: string;
      fileName: string;
      fileSize: number;
      fileType: string;
    },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const senderId = payload.sub;

      // Check if receiver is online
      const receiverSocketId = this.connectedUsers.get(data.receiverId);
      const isReceiverOnline = !!receiverSocketId;

      // Create file message record
      const message = await this.prisma.message.create({
        data: {
          content: data.content,
          type: 'file',
          fileName: data.fileName,
          fileSize: data.fileSize,
          fileType: data.fileType,
          senderId,
          receiverId: data.receiverId,
        },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              email: true,
              avatar: true,
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              email: true,
              avatar: true,
            },
          },
        },
      });

      // Notify receiver if online
      if (receiverSocketId) {
        this.server.to(receiverSocketId).emit('receive_message', {
          ...message,
          isNewMessage: true,
          isReceiverOnline,
        });
        await this.sendUnreadCounts(data.receiverId);
      }

      // Send confirmation to sender with receiver online status
      client.emit('message_sent', {
        ...message,
        isReceiverOnline,
      });
    } catch (error) {
      client.emit('error', { message: 'Failed to send file message' });
    }
  }

  // Check if user is online
  @SubscribeMessage('check_user_online')
  handleCheckUserOnline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId: string },
  ) {
    const isOnline = this.connectedUsers.has(data.userId);
    client.emit('user_online_status', {
      userId: data.userId,
      isOnline,
    });
  }

  // WebRTC Call Handlers
  @SubscribeMessage('initiate_call')
  async handleInitiateCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { receiverId: string; type: 'audio' | 'video' | 'screen' },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const callerId = payload.sub;

      console.log(`Call initiation: ${callerId} -> ${data.receiverId}, type: ${data.type}`);

      // Check if receiver is online
      const receiverSocketId = this.connectedUsers.get(data.receiverId);
      if (!receiverSocketId) {
        console.log(`Receiver ${data.receiverId} is offline`);
        client.emit('call_failed', { reason: 'User is offline' });
        return;
      }

      // Create call record
      const call = await this.prisma.call.create({
        data: {
          type: data.type,
          status: 'initiated',
          callerId,
          receiverId: data.receiverId,
        },
        include: {
          caller: {
            select: { id: true, username: true, avatar: true },
          },
          receiver: {
            select: { id: true, username: true, avatar: true },
          },
        },
      });

      // Store active call with both socket IDs
      this.activeCalls.set(call.id, {
        ...call,
        callerSocketId: client.id,
        receiverSocketId: receiverSocketId,
      });

      console.log(`Created call ${call.id}, notifying both parties`);

      // Notify caller with call ID
      client.emit('call_initiated', { callId: call.id });

      // Notify receiver
      this.server.to(receiverSocketId).emit('incoming_call', {
        callId: call.id,
        caller: call.caller,
        type: data.type,
      });

    } catch (error) {
      console.error('Error initiating call:', error);
      client.emit('call_failed', { message: 'Failed to initiate call' });
    }
  }

  @SubscribeMessage('accept_call')
  async handleAcceptCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    try {
      console.log(`Call acceptance: ${data.callId}`);
      
      const call = this.activeCalls.get(data.callId);
      if (!call) {
        console.log(`Call ${data.callId} not found in active calls`);
        client.emit('call_failed', { message: 'Call not found' });
        return;
      }

      // Update call status in database
      await this.prisma.call.update({
        where: { id: data.callId },
        data: { status: 'accepted' },
      });

      // Update call in memory
      const updatedCall = {
        ...call,
        receiverSocketId: client.id,
        status: 'accepted',
      };
      this.activeCalls.set(data.callId, updatedCall);

      console.log(`Call ${data.callId} accepted, notifying both parties`);

      // Notify both caller and receiver
      if (call.callerSocketId && this.isSocketConnected(call.callerSocketId)) {
        this.server.to(call.callerSocketId).emit('call_accepted', {
          callId: data.callId,
        });
      }

      client.emit('call_accepted', { callId: data.callId });

    } catch (error) {
      console.error('Error accepting call:', error);
      client.emit('call_failed', { message: 'Failed to accept call' });
    }
  }

  @SubscribeMessage('reject_call')
  async handleRejectCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    try {
      console.log(`Call rejection: ${data.callId}`);
      
      const call = this.activeCalls.get(data.callId);
      if (!call) {
        console.log(`Call ${data.callId} not found for rejection`);
        return;
      }

      await this.prisma.call.update({
        where: { id: data.callId },
        data: { status: 'rejected', endedAt: new Date() },
      });

      // Notify caller
      if (call.callerSocketId && this.isSocketConnected(call.callerSocketId)) {
        this.server.to(call.callerSocketId).emit('call_rejected', {
          callId: data.callId,
        });
      }

      this.activeCalls.delete(data.callId);
    } catch (error) {
      console.error('Error rejecting call:', error);
      client.emit('call_failed', { message: 'Failed to reject call' });
    }
  }

  @SubscribeMessage('end_call')
  async handleEndCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    try {
      console.log(`Call ending: ${data.callId}`);
      
      const call = this.activeCalls.get(data.callId);
      if (!call) {
        console.log(`Call ${data.callId} not found for ending`);
        return;
      }

      const duration = Math.floor((Date.now() - new Date(call.createdAt).getTime()) / 1000);

      await this.prisma.call.update({
        where: { id: data.callId },
        data: { 
          status: 'ended', 
          endedAt: new Date(),
          duration: duration,
        },
      });

      // Notify both participants
      const sockets = [call.callerSocketId, call.receiverSocketId].filter(socketId => 
        socketId && this.isSocketConnected(socketId)
      );
      
      sockets.forEach(socketId => {
        this.server.to(socketId).emit('call_ended', {
          callId: data.callId,
        });
      });

      this.activeCalls.delete(data.callId);
    } catch (error) {
      console.error('Error ending call:', error);
      client.emit('call_failed', { message: 'Failed to end call' });
    }
  }

  // Helper method to check if socket is still connected
  private isSocketConnected(socketId: string): boolean {
    return this.server.sockets.sockets.has(socketId);
  }

  // WebRTC Signaling
  @SubscribeMessage('webrtc_offer')
  handleWebRTCOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; offer: any },
  ) {
    console.log(`WebRTC offer for call ${data.callId} from socket ${client.id}`);
    
    const call = this.activeCalls.get(data.callId);
    if (!call) {
      console.log(`Cannot forward offer - call ${data.callId} not found`);
      client.emit('call_failed', { reason: 'Call not found' });
      return;
    }

    const receiverSocketId = call.receiverSocketId;
    if (!receiverSocketId || !this.isSocketConnected(receiverSocketId)) {
      console.log(`Cannot forward offer - receiver not connected`);
      client.emit('call_failed', { reason: 'Receiver disconnected' });
      return;
    }

    console.log(`Forwarding WebRTC offer to receiver socket ${receiverSocketId}`);
    this.server.to(receiverSocketId).emit('webrtc_offer', {
      callId: data.callId,
      offer: data.offer,
    });
  }

  @SubscribeMessage('webrtc_answer')
  handleWebRTCAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; answer: any },
  ) {
    console.log(`WebRTC answer for call ${data.callId} from socket ${client.id}`);
    
    const call = this.activeCalls.get(data.callId);
    if (!call) {
      console.log(`Cannot forward answer - call ${data.callId} not found`);
      client.emit('call_failed', { reason: 'Call not found' });
      return;
    }

    const callerSocketId = call.callerSocketId;
    if (!callerSocketId || !this.isSocketConnected(callerSocketId)) {
      console.log(`Cannot forward answer - caller not connected`);
      client.emit('call_failed', { reason: 'Caller disconnected' });
      return;
    }

    console.log(`Forwarding WebRTC answer to caller socket ${callerSocketId}`);
    this.server.to(callerSocketId).emit('webrtc_answer', {
      callId: data.callId,
      answer: data.answer,
    });
  }

  @SubscribeMessage('webrtc_ice_candidate')
  handleWebRTCIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; candidate: any },
  ) {
    console.log(`WebRTC ICE candidate for call ${data.callId} from socket ${client.id}`);
    
    const call = this.activeCalls.get(data.callId);
    if (!call) {
      console.log(`Cannot forward ICE candidate - call not found`);
      return;
    }

    // Send to the other participant
    const targetSocketId = client.id === call.callerSocketId 
      ? call.receiverSocketId 
      : call.callerSocketId;

    if (targetSocketId && this.isSocketConnected(targetSocketId)) {
      this.server.to(targetSocketId).emit('webrtc_ice_candidate', {
        callId: data.callId,
        candidate: data.candidate,
      });
      console.log(`Forwarded ICE candidate to socket ${targetSocketId}`);
    } else {
      console.log(`Cannot forward ICE candidate - target socket not connected`);
    }
  }

  // Helper methods
  private async handleUserDisconnectFromCalls(userId: string) {
    console.log(`Handling call disconnection for user ${userId}`);
    
    for (const [callId, call] of this.activeCalls.entries()) {
      if (call.callerId === userId || call.receiverId === userId) {
        console.log(`Ending call ${callId} due to user disconnect`);
        
        try {
          await this.prisma.call.update({
            where: { id: callId },
            data: { status: 'ended', endedAt: new Date() },
          });
        } catch (error) {
          console.error(`Failed to update call ${callId} in database:`, error);
        }

        // Notify the other participant
        const otherSocketId = call.callerId === userId 
          ? call.receiverSocketId 
          : call.callerSocketId;

        if (otherSocketId && this.isSocketConnected(otherSocketId)) {
          this.server.to(otherSocketId).emit('call_ended', { callId });
        }

        this.activeCalls.delete(callId);
      }
    }
  }

  // Message handling methods
  @SubscribeMessage('send_message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { receiverId: string; content: string },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const senderId = payload.sub;

      const message = await this.prisma.message.create({
        data: {
          content: data.content,
          senderId,
          receiverId: data.receiverId,
          type: 'text',
        },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              email: true,
              avatar: true,
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              email: true,
              avatar: true,
            },
          },
        },
      });

      const receiverSocketId = this.connectedUsers.get(data.receiverId);
      if (receiverSocketId) {
        this.server.to(receiverSocketId).emit('receive_message', {
          ...message,
          isNewMessage: true,
        });
        await this.sendUnreadCounts(data.receiverId);
      }

      client.emit('message_sent', message);
    } catch (error) {
      client.emit('error', { message: 'Failed to send message' });
    }
  }

  @SubscribeMessage('get_messages')
  async handleGetMessages(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { otherUserId: string },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const currentUserId = payload.sub;

      const messages = await this.prisma.message.findMany({
        where: {
          OR: [
            {
              senderId: currentUserId,
              receiverId: data.otherUserId,
            },
            {
              senderId: data.otherUserId,
              receiverId: currentUserId,
            },
          ],
        },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              email: true,
              avatar: true,
            },
          },
          receiver: {
            select: {
              id: true,
              username: true,
              email: true,
              avatar: true,
            },
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      client.emit('messages_history', messages);
    } catch (error) {
      client.emit('error', { message: 'Failed to get messages' });
    }
  }

  @SubscribeMessage('mark_messages_read')
  async handleMarkMessagesRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { senderId: string },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const currentUserId = payload.sub;

      await this.prisma.message.updateMany({
        where: {
          senderId: data.senderId,
          receiverId: currentUserId,
          isRead: false,
        },
        data: {
          isRead: true,
        },
      });

      await this.sendUnreadCounts(currentUserId);

      const senderSocketId = this.connectedUsers.get(data.senderId);
      if (senderSocketId) {
        this.server.to(senderSocketId).emit('messages_marked_read', {
          senderId: data.senderId,
          receiverId: currentUserId,
        });
      }

      client.emit('messages_marked_read', { 
        senderId: data.senderId,
        receiverId: currentUserId,
      });
    } catch (error) {
      client.emit('error', { message: 'Failed to mark messages as read' });
    }
  }

  @SubscribeMessage('set_active_chat')
  async handleSetActiveChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { receiverId: string | null },
  ) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const currentUserId = payload.sub;

      if (data.receiverId) {
        this.userActiveChats.set(currentUserId, data.receiverId);
        
        const updatedMessages = await this.prisma.message.updateMany({
          where: {
            senderId: data.receiverId,
            receiverId: currentUserId,
            isRead: false,
          },
          data: {
            isRead: true,
          },
        });

        await this.sendUnreadCounts(currentUserId);

        if (updatedMessages.count > 0) {
          const senderSocketId = this.connectedUsers.get(data.receiverId);
          if (senderSocketId) {
            this.server.to(senderSocketId).emit('messages_marked_read', {
              senderId: data.receiverId,
              receiverId: currentUserId,
            });
          }
        }
      } else {
        this.userActiveChats.delete(currentUserId);
      }
    } catch (error) {
      client.emit('error', { message: 'Failed to set active chat' });
    }
  }

  @SubscribeMessage('get_unread_counts')
  async handleGetUnreadCounts(@ConnectedSocket() client: Socket) {
    try {
      const token = client.handshake.auth.token;
      const payload = this.jwtService.verify(token);
      const currentUserId = payload.sub;

      await this.sendUnreadCounts(currentUserId);
    } catch (error) {
      client.emit('error', { message: 'Failed to get unread counts' });
    }
  }

  private async sendUnreadCounts(userId: string) {
    try {
      const unreadCounts = await this.prisma.message.groupBy({
        by: ['senderId'],
        where: {
          receiverId: userId,
          isRead: false,
        },
        _count: {
          id: true,
        },
      });

      const counts = unreadCounts.reduce((acc, item) => {
        acc[item.senderId] = item._count.id;
        return acc;
      }, {} as Record<string, number>);

      const socketId = this.connectedUsers.get(userId);
      if (socketId) {
        this.server.to(socketId).emit('unread_counts', counts);
      }
    } catch (error) {
      console.error('Failed to send unread counts:', error);
    }
  }
}